import { env, runInDurableObject } from 'cloudflare:test';
import { expect, test, vi } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import type { LanguageModel } from 'ai';
import { reserveAgentCredits } from '../src/agents/runtime/billing';
import { creditBalance } from '../src/lib/entitlements';
import type { AgentTurnResult, EvidencePacket, FinalizeAnswerInput } from '../src/agents/contracts';
import type { EvidenceToolExecution } from '../src/agents/providers/youtube/tool-context';
import type { SessionEvidenceStore } from '../src/agents/runtime/session-evidence';
import type { AgentRuntimeDO } from '../src/agents/agent-runtime-do';
import { remember } from './fixtures/memory';

const usage = { inputTokens: { total: 1_000, noCache: 1_000, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 100, text: 100, reasoning: 0 } };

interface Internals {
  sessionStore: SessionEvidenceStore;
  finalizeRun(runId: string, toolCallId: string, input: FinalizeAnswerInput): Promise<AgentTurnResult>;
  performEvidenceTool(runId: string, execution: EvidenceToolExecution): Promise<EvidencePacket>;
  memoryUpdaterModel(runId: string): LanguageModel;
  processMemoryJobs(): Promise<void>;
}
const internals = (instance: AgentRuntimeDO) => instance as unknown as Internals;

interface JobRow { run_id: string; status: string; attempts: number; outcome: string | null }

async function seed(name: string) {
  const runtime = env.AGENT_RUNTIME.getByName(name);
  const userId = name;
  await env.DB.prepare('INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,?,?,?)')
    .bind(userId, 'Test', `${name}@test.local`, 1, Date.now(), Date.now()).run();
  const conversationId = crypto.randomUUID();
  const addRun = async (instance: AgentRuntimeDO, turn: number, message = 'Compare the interviewers. I only care about the second video.') => {
    const runId = crypto.randomUUID();
    // Public reads initialize the real Agent SDK and SQLite schema without inference.
    await instance.getRun(runId);
    await reserveAgentCredits(env, userId, runId);
    instance.sql`INSERT INTO agent_runs (id,user_id,conversation_id,user_message_id,agent_message_id,turn_ordinal,message,status,phase,
      credits_remaining_at_admission,created_at,updated_at,research_deadline_at)
      VALUES (${runId},${userId},${conversationId},${crypto.randomUUID()},${crypto.randomUUID()},${turn},${message},'running','executing',1000,0,0,0)`;
    instance.sql`INSERT INTO agent_routes VALUES (${runId},${JSON.stringify({ route: 'finalize', responseIntent: 'context_answer', reason: 'Stored context' })},0)`;
    internals(instance).sessionStore.beginRun(runId);
    return runId;
  };
  return { runtime, userId, conversationId, addRun };
}

/** Save a transcript asset and a run evidence packet; returns a citable excerpt. */
async function evidence(instance: AgentRuntimeDO, runId: string, videoId = 'abcdefghijk') {
  const writer = internals(instance);
  const raw = await writer.sessionStore.retrieve(`transcript:${videoId}:default`, 'transcript', videoId, false,
    async () => ({ value: { videoId, text: 'The woman holds the microphone.', segments: [{ text: 'The woman holds the microphone.', startMs: 0, endMs: 1000, durationMs: 1000 }] }, cacheStatus: 'miss' }),
    () => ({ complete: true }));
  const version = raw.assetVersions![0]!;
  const packet = await writer.performEvidenceTool(runId, { toolCallId: `transcript-${videoId}`, toolName: 'get_video_transcript',
    semanticKey: `transcript-${videoId}`, operation: 'transcript', input: { videoId },
    execute: async () => ({ packetId: `packet-${videoId}`, kind: 'youtube_transcript', assetVersions: [version],
      sources: [{ id: 'source', provider: 'youtube', kind: 'transcript', videoId }],
      excerpts: [{ id: 'local', sourceId: 'source', text: 'The woman holds the microphone.' }], artifacts: [], warnings: [], usage: [] }) });
  return { version, excerptId: packet.excerpts[0]!.id };
}

const answer = (text: string): FinalizeAnswerInput =>
  ({ intent: 'context_answer', answer: text, confidence: 'high', citations: [], artifacts: [], warnings: [] });
const deltaModel = (changes: unknown[] | (() => unknown[] | Promise<unknown[]>)) => new MockLanguageModelV4({ doGenerate: async () => ({
  content: [{ type: 'text', text: JSON.stringify({ changes: typeof changes === 'function' ? await changes() : changes }) }],
  finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] }) });
const upsert = (kind: string, topic: string, text: string, extra: Record<string, unknown> = {}) =>
  ({ action: 'upsert', kind, topic, text, evidenceIds: [], userQuote: '', ...extra });
const jobs = (instance: AgentRuntimeDO) => instance.sql<JobRow>`SELECT run_id, status, attempts, outcome FROM agent_memory_jobs`;
const reported = (instance: AgentRuntimeDO) => instance.sql<{ call_id: string }>`SELECT call_id FROM agent_memory_cost_reports ORDER BY call_id`
  .map(row => row.call_id);
const memoryLedger = (userId: string) => env.DB.prepare(
  `SELECT operation_id, credits, provider_cost_micros FROM credit_ledger WHERE user_id = ? AND operation_id LIKE 'agent-memory:%' ORDER BY operation_id`,
).bind(userId).all<{ operation_id: string; credits: number; provider_cost_micros: number }>().then(rows => rows.results);

/** Holds the next SHA-256 digest open: the async gap before acceptance validation. */
function holdNextDigest() {
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const spy = vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(async (...args: Parameters<typeof digest>) => {
    entered();
    await gate;
    return digest(...args);
  });
  return { reached, release, restore: () => spy.mockRestore() };
}

test('an accepted answer commits one memory job; the updater applies a cited finding once and settles its cost once', async () => {
  const { runtime, userId, addRun } = await seed('memory-job-accepted');
  let settled = -1;
  await runInDurableObject(runtime, async instance => {
    const runId = await addRun(instance, 1);
    const { excerptId } = await evidence(instance, runId);
    const model = deltaModel([upsert('finding', 'interviewer', 'The woman holds the microphone.', { evidenceIds: [excerptId] }),
      upsert('context', 'scope', 'Only the second video', { userQuote: 'I only care about the second video' })]);
    vi.spyOn(internals(instance), 'memoryUpdaterModel').mockReturnValue(model);
    const saved = await internals(instance).finalizeRun(runId, 'final', answer(`The woman holds it. [cite:${excerptId}]`));
    // Duplicate finalize and duplicate dispatch do not repeat the call or the delta.
    expect(await internals(instance).finalizeRun(runId, 'final-again', answer('A different answer'))).toEqual(saved);
    await Promise.all([internals(instance).processMemoryJobs(), internals(instance).processMemoryJobs()]);
    await internals(instance).processMemoryJobs();
    expect(model.doGenerateCalls).toHaveLength(1);
    expect(jobs(instance)).toMatchObject([{ run_id: runId, status: 'completed', attempts: 1 }]);
    expect(reported(instance)).toEqual(['memory-update:1']);
    const memories = internals(instance).sessionStore.brief().memories;
    expect(memories.map(memory => memory.topic).sort()).toEqual(['interviewer', 'scope']);
    expect(instance.sql`SELECT call_id FROM agent_model_usage WHERE category = 'memory_update'`).toEqual([{ call_id: 'memory-update:1' }]);
    settled = saved.billing.creditsRemaining;
  });
  // Memory cost is zero-credit telemetry: the settled answer balance is unchanged.
  expect(await creditBalance(env, userId)).toBe(settled);
  const ledger = await memoryLedger(userId);
  expect(ledger).toHaveLength(1);
  expect(ledger[0]).toMatchObject({ operation_id: expect.stringMatching(/:memory-update:1$/), credits: 0 });
  expect(ledger[0]!.provider_cost_micros).toBeGreaterThan(0);
});

test('memory failure leaves the completed answer and credits intact and records each observed call once', async () => {
  const { runtime, userId, addRun } = await seed('memory-job-failure');
  let settled = -1;
  await runInDurableObject(runtime, async instance => {
    const runId = await addRun(instance, 1);
    const invalid = new MockLanguageModelV4({ doGenerate: async () => ({ content: [{ type: 'text', text: '{"changes":' }],
      finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] }) });
    vi.spyOn(internals(instance), 'memoryUpdaterModel').mockReturnValue(invalid);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const saved = await internals(instance).finalizeRun(runId, 'final', answer('An accepted answer.'));
    await internals(instance).processMemoryJobs();
    warn.mockRestore();
    expect(invalid.doGenerateCalls).toHaveLength(2);
    expect(jobs(instance)).toMatchObject([{ status: 'failed', attempts: 2, outcome: 'model_failed' }]);
    expect(reported(instance)).toEqual(['memory-update:1', 'memory-update:2']);
    expect(await instance.getRun(runId)).toMatchObject({ status: 'completed', result: { answer: saved.answer } });
    expect(instance.sql`SELECT call_id FROM agent_model_usage WHERE category = 'memory_update' ORDER BY call_id`)
      .toEqual([{ call_id: 'memory-update:1' }, { call_id: 'memory-update:2' }]);
    expect(internals(instance).sessionStore.brief().memories).toEqual([]);
    settled = saved.billing.creditsRemaining;
  });
  expect(await creditBalance(env, userId)).toBe(settled);
  expect((await memoryLedger(userId)).map(entry => [entry.operation_id.split(':').slice(-2).join(':'), entry.credits]))
    .toEqual([['memory-update:1', 0], ['memory-update:2', 0]]);
});

test('rejected intents and application fallback answers commit no memory job; a repaired answer does', async () => {
  const { runtime, addRun } = await seed('memory-job-eligibility');
  await runInDurableObject(runtime, async instance => {
    const rejected = await addRun(instance, 1, 'Book me a flight.');
    instance.sql`UPDATE agent_routes SET decision_json = ${JSON.stringify({ route: 'rejected', reason: 'Unsupported task.' })} WHERE run_id = ${rejected}`;
    await internals(instance).finalizeRun(rejected, 'final', { ...answer('I can only research YouTube videos.'), intent: 'rejected', confidence: 'low' });
    const fallback = await addRun(instance, 2);
    await internals(instance).finalizeRun(fallback, `evidence-fallback:${fallback}`, answer('The transcript could not be retrieved.'));
    const unavailable = await addRun(instance, 3);
    await internals(instance).finalizeRun(unavailable, `evidence-unavailable:${unavailable}`, answer('No evidence was available.'));
    expect(jobs(instance)).toEqual([]);
    // A repair happens before acceptance; the second finalizer attempt's answer is eligible.
    const repaired = await addRun(instance, 4, 'Who holds the microphone? I only care about the second video.');
    const model = deltaModel([upsert('context', 'scope', 'Only the second video', { userQuote: 'I only care about the second video' })]);
    vi.spyOn(internals(instance), 'memoryUpdaterModel').mockReturnValue(model);
    await internals(instance).finalizeRun(repaired, `timeout-finalizer:${repaired}:1`, answer('The woman holds the microphone.'));
    await internals(instance).processMemoryJobs();
    expect(jobs(instance)).toMatchObject([{ run_id: repaired, status: 'completed' }]);
    expect(internals(instance).sessionStore.brief().memories.map(memory => memory.topic)).toEqual(['scope']);
    // The updater sees the stored request and accepted answer only.
    const prompt = JSON.stringify(model.doGenerateCalls[0]!.prompt);
    expect(prompt).toContain('The woman holds the microphone.');
    for (const leaked of ['validationFeedback', 'previousCandidate', 'conversationHistory', 'providerFailures'])
      expect(prompt).not.toContain(leaked);
  });
});

test('an abort-ignoring updater is bounded by the wall clock; its late delta never lands and its late cost is reported once', async () => {
  const { runtime, userId, addRun } = await seed('memory-job-abort-ignoring');
  await runInDurableObject(runtime, async instance => {
    const runId = await addRun(instance, 1);
    let respond!: () => void;
    const late = new Promise<void>(resolve => { respond = resolve; });
    const model = new MockLanguageModelV4({ doGenerate: async () => {
      await late; // Ignores abortSignal.
      return { content: [{ type: 'text', text: JSON.stringify({ changes: [
        upsert('context', 'scope', 'Only the second video', { userQuote: 'I only care about the second video' })] }) }],
        finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] };
    } });
    vi.spyOn(internals(instance), 'memoryUpdaterModel').mockReturnValue(model);
    vi.spyOn(instance as unknown as { memoryUpdateTimeoutMs(): number }, 'memoryUpdateTimeoutMs').mockReturnValue(50);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await internals(instance).finalizeRun(runId, 'final', answer('An accepted answer.'));
    const started = Date.now();
    await internals(instance).processMemoryJobs();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(model.doGenerateCalls).toHaveLength(2);
    expect(jobs(instance)).toMatchObject([{ status: 'failed', attempts: 2, outcome: 'timeout' }]);
    expect(await instance.getRun(runId)).toMatchObject({ status: 'completed' });
    expect(reported(instance)).toEqual([]);
    // Both calls respond after their deadlines.
    respond();
    await vi.waitFor(() => expect(reported(instance)).toEqual(['memory-update:1', 'memory-update:2']));
    await internals(instance).processMemoryJobs();
    warn.mockRestore();
    expect(internals(instance).sessionStore.brief().memories).toEqual([]);
    expect(jobs(instance)).toMatchObject([{ status: 'failed', attempts: 2, outcome: 'timeout' }]);
  });
  expect((await memoryLedger(userId)).map(entry => entry.credits)).toEqual([0, 0]);
});

test('account deletion completes while an abort-ignoring updater is in flight; a late response recreates nothing', async () => {
  const { runtime, userId, addRun } = await seed('memory-job-delete-abort-ignoring');
  await runInDurableObject(runtime, async (instance, state) => {
    const runId = await addRun(instance, 1);
    let respond!: () => void;
    let entered!: () => void;
    const late = new Promise<void>(resolve => { respond = resolve; });
    const inFlight = new Promise<void>(resolve => { entered = resolve; });
    const model = new MockLanguageModelV4({ doGenerate: async () => {
      entered();
      await late; // Ignores abortSignal.
      return { content: [{ type: 'text', text: JSON.stringify({ changes: [
        upsert('context', 'scope', 'Only the second video', { userQuote: 'I only care about the second video' })] }) }],
        finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] };
    } });
    vi.spyOn(internals(instance), 'memoryUpdaterModel').mockReturnValue(model);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await internals(instance).finalizeRun(runId, 'final', answer('An accepted answer.'));
    await inFlight;
    const started = Date.now();
    // Deletion aborts the in-flight call; the application deadline releases the drain at once.
    await instance.deleteAccountData();
    expect(Date.now() - started).toBeLessThan(5_000);
    respond();
    await new Promise(resolve => setTimeout(resolve, 50));
    warn.mockRestore();
    expect(model.doGenerateCalls).toHaveLength(1);
    for (const table of ['agent_memory_jobs', 'agent_memory_cost_reports', 'agent_model_usage', 'session_memories', 'session_memory_writes', 'agent_runs'])
      expect(state.storage.sql.exec(`SELECT COUNT(*) AS count FROM ${table}`).one()).toMatchObject({ count: 0 });
    expect(instance.getSchedules()).toEqual([]);
  });
  // The late call's cost was never observed while its run existed: documented as unobservable.
  expect(await memoryLedger(userId)).toEqual([]);
});

test('near the run cost limit, a delayed unobserved first call blocks the retry; its late cost is reported once', async () => {
  const { runtime, userId, addRun } = await seed('memory-job-cost-edge');
  await runInDurableObject(runtime, async instance => {
    const runId = await addRun(instance, 1);
    // Answer-phase telemetry leaves room for exactly one estimated memory call.
    instance.sql`INSERT INTO agent_model_usage (run_id, call_id, category, model_id, input_tokens, cached_input_tokens,
      output_tokens, estimated_cost_micros, created_at) VALUES (${runId}, 'answer', 'timeout_finalizer', 'model', 0, 0, 0, 979000, 0)`;
    let respond!: () => void;
    const late = new Promise<void>(resolve => { respond = resolve; });
    const model = new MockLanguageModelV4({ doGenerate: async () => {
      await late; // Ignores abortSignal.
      return { content: [{ type: 'text', text: JSON.stringify({ changes: [] }) }],
        finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] };
    } });
    vi.spyOn(internals(instance), 'memoryUpdaterModel').mockReturnValue(model);
    vi.spyOn(instance as unknown as { memoryUpdateTimeoutMs(): number }, 'memoryUpdateTimeoutMs').mockReturnValue(50);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await internals(instance).finalizeRun(runId, 'final', answer('An accepted answer.'));
    await internals(instance).processMemoryJobs();
    // 979,000 observed + 20,000 for the unobserved first call + 20,000 for a retry exceeds 1,000,000.
    expect(model.doGenerateCalls).toHaveLength(1);
    expect(jobs(instance)).toMatchObject([{ status: 'skipped', attempts: 1, outcome: 'cost_limit' }]);
    respond();
    await vi.waitFor(() => expect(reported(instance)).toEqual(['memory-update:1']));
    await internals(instance).processMemoryJobs();
    await internals(instance).processMemoryJobs();
    warn.mockRestore();
    expect(reported(instance)).toEqual(['memory-update:1']);
    expect(instance.sql`SELECT COUNT(*) AS count FROM agent_model_usage WHERE category = 'memory_update'`).toEqual([{ count: 1 }]);
    expect(await instance.getRun(runId)).toMatchObject({ status: 'completed' });
  });
  expect((await memoryLedger(userId)).map(entry => entry.credits)).toEqual([0]);
});

test('an older explicit branch accepted after a newer correction cannot overwrite that topic', async () => {
  const { runtime, addRun } = await seed('memory-job-branches');
  await runInDurableObject(runtime, async instance => {
    const older = await addRun(instance, 1, 'I prefer short answers.');
    const newer = await addRun(instance, 2, 'Actually I prefer detailed answers.');
    const store = internals(instance).sessionStore;
    vi.spyOn(internals(instance), 'memoryUpdaterModel').mockReturnValue(
      deltaModel([upsert('context', 'Length', 'Prefers detailed answers', { userQuote: 'I prefer detailed answers' })]));
    await internals(instance).finalizeRun(newer, 'final', answer('A detailed answer.'));
    await internals(instance).processMemoryJobs();
    // The older turn finishes later and proposes the opposite value for the same normalized topic.
    vi.spyOn(internals(instance), 'memoryUpdaterModel').mockReturnValue(
      deltaModel([upsert('context', 'length ', 'Prefers short answers', { userQuote: 'I prefer short answers' }),
        upsert('context', 'brevity', 'Prefers short answers', { userQuote: 'I prefer short answers' })]));
    await internals(instance).finalizeRun(older, 'final', answer('A short answer.'));
    await internals(instance).processMemoryJobs();
    expect(jobs(instance).map(job => job.status)).toEqual(['completed', 'completed']);
    // Ordering is per normalized kind/topic: a differently named topic is not treated as a conflict.
    expect(Object.fromEntries(store.brief().memories.map(memory => [memory.topic, memory.text])))
      .toEqual({ Length: 'Prefers detailed answers', brevity: 'Prefers short answers' });
  });
});

test('failed and cancelled runs commit no memory job', async () => {
  const { runtime, addRun } = await seed('memory-job-failed-runs');
  await runInDurableObject(runtime, async instance => {
    const runId = await addRun(instance, 1);
    await instance.cancelRun(runId);
    await expect(internals(instance).finalizeRun(runId, 'final', answer('Too late.'))).rejects.toThrow('no longer active');
    expect(jobs(instance)).toEqual([]);
  });
});

test.each(['cancel', 'single-delete', 'bulk-delete'] as const)('%s during the async acceptance gap commits neither the answer nor its memory job', async race => {
  const { runtime, userId, conversationId, addRun } = await seed(`memory-acceptance-${race}`);
  await runInDurableObject(runtime, async instance => {
    const runId = await addRun(instance, 1);
    const { version, excerptId } = await evidence(instance, runId);
    vi.spyOn(internals(instance), 'memoryUpdaterModel').mockReturnValue(deltaModel([]));
    const hold = holdNextDigest();
    const pending = internals(instance).finalizeRun(runId, 'final', answer(`The woman holds it. [cite:${excerptId}]`));
    await hold.reached;
    if (race === 'cancel') await instance.cancelRun(runId);
    else await instance.deleteSessionAssets(conversationId, userId, race === 'single-delete' ? version : undefined);
    hold.release();
    await expect(pending).rejects.toThrow(race === 'cancel' ? 'no longer active' : 'does not reference persisted evidence');
    hold.restore();
    expect(instance.sql`SELECT result_json FROM agent_runs WHERE id = ${runId}`).toEqual([{ result_json: null }]);
    expect(jobs(instance)).toEqual([]);
  });
});

test('a concurrent finalize accepted during the gap is not overwritten', async () => {
  const { runtime, addRun } = await seed('memory-acceptance-concurrent');
  await runInDurableObject(runtime, async instance => {
    const runId = await addRun(instance, 1);
    vi.spyOn(internals(instance), 'memoryUpdaterModel').mockReturnValue(deltaModel([]));
    const hold = holdNextDigest();
    const first = internals(instance).finalizeRun(runId, 'first', answer('The first answer.'));
    await hold.reached;
    const second = await internals(instance).finalizeRun(runId, 'second', answer('The second answer.'));
    hold.release();
    expect(await first).toEqual(second);
    hold.restore();
    expect(second.answer).toBe('The second answer.');
    expect(jobs(instance)).toHaveLength(1);
    await internals(instance).processMemoryJobs();
    expect(jobs(instance)).toMatchObject([{ status: 'completed' }]);
  });
});

test('a job committed before dispatch and a job interrupted in flight both recover once after restart', async () => {
  const { runtime, addRun } = await seed('memory-job-recovery');
  await runInDurableObject(runtime, async instance => {
    const first = await addRun(instance, 1);
    const second = await addRun(instance, 2);
    vi.spyOn(internals(instance), 'memoryUpdaterModel').mockReturnValue(deltaModel([]));
    await internals(instance).finalizeRun(first, 'final', answer('First accepted answer.'));
    await internals(instance).finalizeRun(second, 'final', answer('Second accepted answer.'));
    await internals(instance).processMemoryJobs();
    // Simulate the crash windows: one job never dispatched, one claimed by a lost process.
    instance.sql`UPDATE agent_memory_jobs SET status = 'pending', attempts = 0 WHERE run_id = ${first}`;
    instance.sql`UPDATE agent_memory_jobs SET status = 'running', attempts = 1 WHERE run_id = ${second}`;
    instance.sql`DELETE FROM agent_model_usage WHERE category = 'memory_update'`;
    instance.sql`DELETE FROM agent_memory_cost_reports`;
    const model = deltaModel([upsert('question', 'other participant', 'Who is the other participant?')]);
    vi.spyOn(internals(instance), 'memoryUpdaterModel').mockReturnValue(model);
    await instance.onStart();
    await internals(instance).processMemoryJobs();
    expect(model.doGenerateCalls).toHaveLength(2);
    expect(jobs(instance).map(job => [job.status, job.attempts])).toEqual([['completed', 1], ['completed', 2]]);
    // The persisted backstop stays armed only while work remains.
    expect(instance.getSchedules().filter(schedule => schedule.callback === 'processMemoryJobs')).toEqual([]);
  });
});

test('an older branch finishing later cannot overwrite a newer correction, and a stale snapshot is retried', async () => {
  const { runtime, addRun } = await seed('memory-job-ordering');
  await runInDurableObject(runtime, async instance => {
    const older = await addRun(instance, 1, 'I prefer short answers.');
    const newer = await addRun(instance, 2, 'Actually I prefer detailed answers.');
    const store = internals(instance).sessionStore;
    // The newer branch's correction was already committed.
    remember(store, newer, [{ kind: 'context', topic: 'length', text: 'Prefers detailed answers' }], undefined, 2);
    let calls = 0;
    const model = deltaModel(() => {
      // The first call races with an unrelated memory write, so its snapshot is stale.
      if (calls++ === 0) remember(store, newer, [{ kind: 'question', topic: 'open', text: 'Which speaker?' }], undefined, 2);
      return [upsert('context', 'length', 'Prefers short answers', { userQuote: 'I prefer short answers' }),
        upsert('context', 'style', 'Prefers short answers', { userQuote: 'I prefer short answers' })];
    });
    vi.spyOn(internals(instance), 'memoryUpdaterModel').mockReturnValue(model);
    await internals(instance).finalizeRun(older, 'final', answer('A short answer.'));
    await internals(instance).processMemoryJobs();
    expect(model.doGenerateCalls).toHaveLength(2);
    expect(jobs(instance)).toMatchObject([{ status: 'completed', attempts: 2 }]);
    const memories = Object.fromEntries(store.brief().memories.map(memory => [memory.topic, memory.text]));
    expect(memories).toEqual({ length: 'Prefers detailed answers', open: 'Which speaker?', style: 'Prefers short answers' });
  });
});

test.each(['forget', 'single-delete', 'bulk-delete'] as const)('%s while the updater is in flight cannot restore stale memory', async race => {
  const { runtime, userId, conversationId, addRun } = await seed(`memory-job-${race}-race`);
  await runInDurableObject(runtime, async instance => {
    const runId = await addRun(instance, 1);
    const { version, excerptId } = await evidence(instance, runId);
    const store = internals(instance).sessionStore;
    remember(store, 'earlier', [{ kind: 'context', topic: 'scope', text: 'Old scope' }]);
    const model = deltaModel(async () => {
      if (race === 'forget') await instance.deleteSessionMemory(conversationId, userId, 'context:scope');
      else await instance.deleteSessionAssets(conversationId, userId, race === 'single-delete' ? version : undefined);
      return [upsert('context', 'scope', 'Old scope', { userQuote: 'I only care about the second video' }),
        upsert('finding', 'interviewer', 'The woman holds the microphone.', { evidenceIds: [excerptId] })];
    });
    vi.spyOn(internals(instance), 'memoryUpdaterModel').mockReturnValue(model);
    await internals(instance).finalizeRun(runId, 'final', answer(`The woman holds it. [cite:${excerptId}]`));
    await internals(instance).processMemoryJobs();
    expect(model.doGenerateCalls).toHaveLength(1);
    expect(jobs(instance)).toMatchObject([{ status: 'skipped', outcome: 'session_changed' }]);
    // Nothing from the fenced delta lands. A single-asset delete keeps unrelated, uncited context.
    expect(store.brief().memories.map(memory => [memory.topic, memory.text]))
      .toEqual(race === 'single-delete' ? [['scope', 'Old scope']] : []);
  });
});

test('account deletion aborts an in-flight update and leaves no memory state behind', async () => {
  const { runtime, userId, addRun } = await seed('memory-job-account-delete');
  await runInDurableObject(runtime, async (instance, state) => {
    const runId = await addRun(instance, 1);
    let started!: () => void;
    const inFlight = new Promise<void>(resolve => { started = resolve; });
    const model = new MockLanguageModelV4({ doGenerate: async ({ abortSignal }) => {
      started();
      await new Promise((_, reject) => abortSignal?.addEventListener('abort', () => reject(abortSignal.reason)));
      throw new Error('unreachable');
    } });
    vi.spyOn(internals(instance), 'memoryUpdaterModel').mockReturnValue(model);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await internals(instance).finalizeRun(runId, 'final', answer('An accepted answer.'));
    await inFlight;
    await instance.deleteAccountData();
    warn.mockRestore();
    for (const table of ['agent_memory_jobs', 'session_memories', 'session_memory_writes', 'agent_runs'])
      expect(state.storage.sql.exec(`SELECT COUNT(*) AS count FROM ${table}`).one()).toMatchObject({ count: 0 });
    expect(instance.getSchedules()).toEqual([]);
  });
  // An aborted call has no observed usage, so no memory cost entry is invented.
  expect(await memoryLedger(userId)).toEqual([]);
});

test.each(['success', 'retry', 'budget', 'backup_budget'] as const)('accounts for each memory provider request and rejects abandoned changes: %s', async mode => {
  const { withModelFailover } = await import('../src/agents/runtime/model-failover');
  const { runtime, userId, addRun } = await seed(`memory-failover-usage-${mode}`);
  let providerCost = 0;
  let creditsAfterAnswer = 0;
  await runInDurableObject(runtime, async instance => {
    const runId = await addRun(instance, 1);
    if (mode === 'budget' || mode === 'backup_budget') instance.sql`INSERT INTO agent_model_usage (run_id,call_id,category,model_id,input_tokens,cached_input_tokens,
      output_tokens,estimated_cost_micros,created_at) VALUES (${runId},'answer','timeout_finalizer','model',0,0,0,${mode === 'backup_budget' ? 979000 : 960000},0)`;
    let respond!: () => void;
    const late = new Promise<void>(resolve => { respond = resolve; });
    const primary = new MockLanguageModelV4({ modelId: 'accounts/fireworks/models/glm-5p3-flash', doGenerate: async () => {
      await late;
      return { content: [{ type: 'text', text: JSON.stringify({ changes: [upsert('question', 'abandoned', 'Which speaker?')] }) }],
        finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] };
    } });
    let backupCalls = 0;
    const fallback = new MockLanguageModelV4({ modelId: 'accounts/fireworks/models/deepseek-v4p1-flash', doGenerate: async () => ({
      content: [{ type: 'text', text: mode !== 'success' && backupCalls++ === 0 ? '{"changes":"invalid"}' : '{"changes":[]}' }],
      finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] }) });
    // Shorten only the primary budget here; the unit test exercises the eight-second cutoff.
    const state = { fallback: false, deadlineAt: Date.now() + 10_001 };
    const model = withModelFailover({ primary, fallback, state, role: 'memory_updater' });
    vi.spyOn(internals(instance), 'memoryUpdaterModel').mockReturnValue(model);
    await internals(instance).finalizeRun(runId, 'final', answer('An accepted answer.'));
    creditsAfterAnswer = await creditBalance(env, userId);
    await internals(instance).processMemoryJobs();
    const expectedRequests = mode === 'backup_budget' ? 1 : mode === 'retry' ? 3 : 2;
    expect(primary.doGenerateCalls).toHaveLength(1);
    expect(fallback.doGenerateCalls).toHaveLength(expectedRequests - 1);
    expect(jobs(instance)).toMatchObject([{ status: mode === 'budget' || mode === 'backup_budget' ? 'skipped' : 'completed', attempts: mode === 'retry' ? 2 : 1 }]);
    expect(reported(instance)).toHaveLength(expectedRequests - 1);
    expect(instance.sql`SELECT * FROM agent_events WHERE type = 'memory.request_started'`).toHaveLength(expectedRequests);
    respond();
    await vi.waitFor(() => expect(reported(instance)).toHaveLength(expectedRequests));
    await internals(instance).processMemoryJobs();
    await internals(instance).processMemoryJobs();
    const rows = instance.sql<{ call_id: string; model_id: string; estimated_cost_micros: number }>`
      SELECT call_id,model_id,estimated_cost_micros FROM agent_model_usage WHERE category = 'memory_update'`;
    expect(rows).toHaveLength(expectedRequests);
    expect(new Set(rows.map(row => row.call_id)).size).toBe(expectedRequests);
    expect(rows.filter(row => row.model_id.endsWith('glm-5p3-flash'))).toHaveLength(1);
    providerCost = rows.reduce((total, row) => total + row.estimated_cost_micros, 0);
    expect(internals(instance).sessionStore.brief().memories).toEqual([]);
    expect(await instance.getRun(runId)).toMatchObject({ status: 'completed' });
  });
  const ledger = await memoryLedger(userId);
  expect(ledger).toHaveLength(mode === 'backup_budget' ? 1 : mode === 'retry' ? 3 : 2);
  expect(ledger.every(row => row.credits === 0)).toBe(true);
  expect(ledger.reduce((total, row) => total + row.provider_cost_micros, 0)).toBe(providerCost);
  expect(await creditBalance(env, userId)).toBe(creditsAfterAnswer);
});
