import { readAdminToolTrace } from '../src/agents/runtime/admin-tool-traces';
import { executeGetVideoTranscript } from '../src/agents/providers/youtube/tools/get-video-transcript';
import type { AgentToolContext, EvidenceToolExecution } from '../src/agents/providers/youtube/tool-context';
import type { EvidencePacket } from '../src/agents/contracts';
import { extractionFixture } from './fixtures/extraction-diagnostic';
import { env, runInDurableObject } from 'cloudflare:test';
import { expect, test, vi } from 'vitest';
import { reserveAgentCredits, settleAgentCredits } from '../src/agents/runtime/billing';
import { creditBalance } from '../src/lib/entitlements';
import { conversationModelMessages, type ConversationTurn } from '../src/agents/runtime/conversation-memory';
import type { AgentTurnResult, FinalizeAnswerInput } from '../src/agents/contracts';

async function seed(name: string, status = 'failed') {
  const runtime = env.AGENT_RUNTIME.getByName(name);
  const userId = name;
  await env.DB.prepare('INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,?,?,?)')
    .bind(userId, 'Test', `${name}@test.local`, 1, Date.now(), Date.now()).run();
  const runId = crypto.randomUUID();
  const conversationId = crypto.randomUUID();
  await reserveAgentCredits(env, userId, runId);
  await runInDurableObject(runtime, async (instance) => {
    // Public reads initialize the real Agent SDK and SQLite schema without inference.
    await instance.getRun(runId);
    instance.sql`INSERT INTO agent_runs (id,user_id,conversation_id,
      user_message_id,agent_message_id,turn_ordinal,message,status,phase,
      credits_remaining_at_admission,created_at,updated_at,research_deadline_at)
      VALUES (${runId},${userId},${conversationId},${crypto.randomUUID()},${crypto.randomUUID()},
      1,'Private prompt',${status},'executing',1000,0,0,0)`;
    instance.sql`INSERT INTO agent_tool_calls (run_id,tool_call_id,semantic_key,tool_name,operation,status,credits,created_at,updated_at)
      VALUES (${runId},'tool','meaning','get_video','video','completed',1,0,0)`;
  });
  return { runtime, userId, runId, conversationId };
}

test.each(['storyboard', 'transcript'] as const)('persists %s diagnostics across RPCs, isolates owners, and bounds run storage', async kind => {
  const fixture = { ...extractionFixture, kind };
  const { runtime, runId } = await seed(`extraction-diagnostics-${kind}-owner`);
  const other = await seed(`extraction-diagnostics-${kind}-other`);
  await runInDurableObject(runtime, async instance => {
    const writer = instance as unknown as { recordExtractionDiagnostic(runId: string, event: unknown): void };
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const event = { ...fixture, toolCallId: 'storyboard-call', url: 'SECRET' };
      writer.recordExtractionDiagnostic(runId, event);
      writer.recordExtractionDiagnostic(other.runId, event);
      writer.recordExtractionDiagnostic(runId, { ...event, events: [{ stage: 'https://SECRET' }] });
      expect(instance.sql`SELECT * FROM agent_events WHERE type = 'extraction.diagnostic'`).toHaveLength(1);
      expect(JSON.stringify(log.mock.calls)).not.toContain('SECRET');
    } finally { log.mockRestore(); }
  });
  const first = await runtime.getRun(runId) as import('../src/agents/agent-runtime-do').AgentRunView | null;
  expect(first?.extractionDiagnostics).toEqual([{ ...fixture, toolCallId: 'storyboard-call' }]);
  expect((await runtime.getRun(runId) as import('../src/agents/agent-runtime-do').AgentRunView | null)?.extractionDiagnostics).toEqual(first?.extractionDiagnostics);
  expect(await other.runtime.getRun(runId)).toBeNull();
  expect(JSON.stringify(await runtime.getRunProgress(runId))).not.toContain('extractionId');
  await runInDurableObject(runtime, async instance => {
    const writer = instance as unknown as { recordExtractionDiagnostic(runId: string, event: unknown): void };
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      for (let i = 0; i < 70; i++) writer.recordExtractionDiagnostic(runId, { ...fixture, toolCallId: `call-${i}` });
    } finally { log.mockRestore(); }
    expect(instance.sql`SELECT * FROM agent_events WHERE type = 'extraction.truncated'`).toHaveLength(1);
  });
  const bounded = await runtime.getRun(runId) as import('../src/agents/agent-runtime-do').AgentRunView | null;
  expect(bounded?.extractionDiagnostics).toHaveLength(64);
  expect(bounded?.extractionDiagnosticsTruncated).toBe(true);
});

test('enforces the diagnostic byte limit before the attempt count limit', async () => {
  const { runtime, runId } = await seed('extraction-diagnostics-byte-limit');
  await runInDurableObject(runtime, async instance => {
    const writer = instance as unknown as { recordExtractionDiagnostic(runId: string, event: unknown): void };
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const event = { ...extractionFixture, toolCallId: 'large-call', events: Array.from({ length: 64 }, () => ({
      stage: 'media_transfer', profile: 'android', timestampMs: 123456, candidateIndex: 3, candidateCount: 4,
      attempt: 2, delayMs: 100, elapsedMs: 1000, sourceWidth: 1920, sourceHeight: 1080,
      formatId: 137, inputBytes: 100000, outputBytes: 200000, outcome: 'success',
    })) };
    try {
      for (let i = 0; i < 64; i++) writer.recordExtractionDiagnostic(runId, event);
    } finally { log.mockRestore(); }
    const rows = instance.sql<{ payload_json: string }>`SELECT payload_json FROM agent_events WHERE type = 'extraction.diagnostic'`;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(64);
    const bytes = rows.reduce((total, row) => total + new TextEncoder().encode(row.payload_json).byteLength, 0);
    expect(bytes).toBeLessThanOrEqual(256 * 1024);
    expect(bytes + new TextEncoder().encode(JSON.stringify(event)).byteLength).toBeGreaterThan(256 * 1024);
    expect(instance.sql`SELECT * FROM agent_events WHERE type = 'extraction.truncated'`).toHaveLength(1);
  });
});

test('migrates stored agent message IDs without changing answers, history, or parent links', async () => {
  const { runtime, userId, runId, conversationId } = await seed('agent-message-id-migration', 'completed');
  await runInDurableObject(runtime, async instance => {
    const row = instance.sql`SELECT * FROM agent_runs WHERE id = ${runId}`[0]!;
    const agentMessageId = String(row.agent_message_id);
    const saved = JSON.stringify({ runId, conversationId, userMessageId: row.user_message_id,
      assistantMessageId: agentMessageId, intent: 'inspect_video', answer: 'The saved answer.',
      confidence: 'medium', citations: [], artifacts: [], warnings: [],
      billing: { creditsCharged: 1, creditsRemaining: 999 } });
    instance.sql`UPDATE agent_runs SET result_json = ${saved}, billing_settled = 1 WHERE id = ${runId}`;
    instance.sql`INSERT INTO agent_tool_calls
      (run_id,tool_call_id,semantic_key,tool_name,operation,status,result_json,credits,created_at,updated_at)
      VALUES (${runId},'final','finalize','finalize_answer','finalize','completed',${saved},0,0,0)`;
    instance.sql`DROP INDEX agent_runs_agent_message_idx`;
    instance.sql`ALTER TABLE agent_runs RENAME COLUMN agent_message_id TO assistant_message_id`;
    instance.sql`CREATE UNIQUE INDEX agent_runs_assistant_message_idx ON agent_runs (assistant_message_id)`;

    const restored = await instance.getRun(runId);
    expect(restored).toMatchObject({ agentMessageId, result: { agentMessageId, answer: 'The saved answer.' } });
    expect(restored).not.toHaveProperty('assistantMessageId');
    expect(restored?.result).not.toHaveProperty('assistantMessageId');
    const finalOutput = JSON.parse(String(instance.sql`SELECT result_json FROM agent_tool_calls
      WHERE run_id = ${runId} AND tool_call_id = 'final'`[0]!.result_json));
    expect(finalOutput).toEqual(restored?.result);
    expect(await instance.getRun(runId)).toEqual(restored);
    const history = await instance.getConversation(conversationId, userId);
    expect(history?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ messageId: agentMessageId, content: 'The saved answer.' }),
    ]));
    const fiber = vi.spyOn(instance, 'startFiber').mockResolvedValue({
      fiberId: 'migration-followup', name: 'agent-runtime-run', status: 'running', createdAt: Date.now(), accepted: true,
    });
    const followup = await instance.startRun({ message: 'Explain that answer', conversationId, parentMessageId: agentMessageId },
      { userId, creditsRemaining: 999 });
    if ('rejected' in followup) throw Error(followup.message);
    expect(followup.agentMessageId).not.toBe(agentMessageId);
    expect(instance.sql`SELECT parent_message_id FROM agent_runs WHERE id = ${followup.runId}`[0])
      .toEqual({ parent_message_id: agentMessageId });
    expect(instance.sql`PRAGMA table_info(agent_runs)`).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'assistant_message_id' }),
    ]));
    fiber.mockRestore();
  });
});

test('restores provider metadata for follow-ups and validates historical citations without another evidence charge', async () => {
  const { runtime, userId, runId, conversationId } = await seed('agent-metadata-memory', 'completed');
  await runInDurableObject(runtime, async instance => {
    const parent = instance.sql`SELECT * FROM agent_runs WHERE id = ${runId}`[0]!;
    const saved = JSON.stringify({ runId, conversationId, userMessageId: parent.user_message_id,
      agentMessageId: parent.agent_message_id, intent: 'inspect_video', answer: 'A summary.',
      confidence: 'medium', citations: [], artifacts: [{ type: 'youtube_video_metadata', data: { id: 'abcdefghijk', viewCount: 999999 } }],
      warnings: [], billing: { creditsCharged: 1, creditsRemaining: 999 } });
    instance.sql`UPDATE agent_runs SET result_json = ${saved} WHERE id = ${runId}`;
    const packetId = `packet:${runId}:video`;
    const packet = JSON.stringify({ packetId, kind: 'youtube_video',
      sources: [{ id: 'video', provider: 'youtube', kind: 'video', videoId: 'abcdefghijk', title: 'A video' }],
      excerpts: [], artifacts: [{ type: 'youtube_video_metadata', title: 'A video', data: { id: 'abcdefghijk', viewCount: 404433 } }],
      warnings: [], usage: [{ operation: 'video', credits: 1, cacheStatus: 'miss' }] });
    instance.sql`INSERT INTO agent_evidence_packets (packet_id,run_id,tool_call_id,packet_json,created_at)
      VALUES (${packetId},${runId},'tool',${packet},2000)`;
    const fiber = vi.spyOn(instance, 'startFiber').mockResolvedValue({ fiberId: 'metadata-test', name: 'agent-runtime-run',
      status: 'running', createdAt: Date.now(), accepted: true });
    const receipt = await instance.startRun({ message: 'How many views did it have?', conversationId },
      { userId, creditsRemaining: 999 });
    if ('rejected' in receipt) throw Error(receipt.message);
    await reserveAgentCredits(env, userId, receipt.runId);
    const row = instance.sql`SELECT * FROM agent_runs WHERE id = ${receipt.runId}`[0]!;
    const methods = instance as unknown as {
      readConversationHistory(row: unknown): ConversationTurn[];
      finalizeRun(runId: string, toolCallId: string, input: FinalizeAnswerInput): Promise<AgentTurnResult>;
    };
    const history = methods.readConversationHistory(row);
    const modelMemory = JSON.stringify(conversationModelMessages(history, 'How many views did it have?'));
    expect(modelMemory).toContain('404433');
    expect(modelMemory).not.toContain('999999');
    expect(history[0]?.resourceIds).toContain('abcdefghijk');
    expect(() => methods.readConversationHistory({ ...row, user_id: 'another-user' })).toThrow(/parent/);
    expect(() => methods.readConversationHistory({ ...row, conversation_id: crypto.randomUUID() })).toThrow(/parent/);
    const citationId = history[0]!.metadata![0]!.excerpts[0]!.id;
    const route = JSON.stringify({ route: 'inspect_video', videoId: 'abcdefghijk', useStoryboard: false });
    instance.sql`INSERT INTO agent_routes (run_id,decision_json,created_at) VALUES (${receipt.runId},${route},2001)`;
    const result = await methods.finalizeRun(receipt.runId, 'final', { intent: 'inspect_video', confidence: 'medium',
      answer: `The earlier record showed 404433 views. [cite:${citationId}]`, citations: [], artifacts: [], warnings: [] });
    expect(result.citations[0]).toMatchObject({ videoId: 'abcdefghijk' });
    expect(result.billing.creditsCharged).toBe(0);
    expect(instance.sql`SELECT * FROM agent_evidence_packets WHERE run_id = ${receipt.runId}`).toHaveLength(0);
    fiber.mockRestore();
  });
});

test('direct finalization restores cited frame evidence from ancestors and rejects other references', async () => {
  const { runtime, userId, runId, conversationId } = await seed('agent-frame-context', 'completed');
  await runInDurableObject(runtime, async instance => {
    const parent = instance.sql`SELECT * FROM agent_runs WHERE id = ${runId}`[0]!;
    const citation = { id: 'frame-proof', sourceId: 'video', provider: 'youtube', videoId: 'abcdefghijk',
      excerpt: 'The woman holds the microphone.', startMs: 30000 };
    const saved = JSON.stringify({ runId, conversationId, userMessageId: parent.user_message_id,
      agentMessageId: parent.agent_message_id, intent: 'inspect_video', answer: 'The woman holds the microphone.',
      confidence: 'medium', citations: [citation], artifacts: [], warnings: [],
      billing: { creditsCharged: 1, creditsRemaining: 999 } });
    instance.sql`UPDATE agent_runs SET result_json = ${saved} WHERE id = ${runId}`;
    for (const id of ['frame-proof', 'uncited-proof']) {
      const packet = JSON.stringify({ packetId: id, kind: 'youtube_frames',
        sources: [{ id: 'video', provider: 'youtube', kind: 'video', videoId: 'abcdefghijk' }],
        excerpts: [{ id, sourceId: 'video', text: citation.excerpt, startMs: 30000 }],
        artifacts: [], warnings: [], usage: [] });
      instance.sql`INSERT INTO agent_evidence_packets (packet_id,run_id,tool_call_id,packet_json,created_at)
        VALUES (${id},${runId},'tool',${packet},2000)`;
    }
    const fiber = vi.spyOn(instance, 'startFiber').mockResolvedValue({ fiberId: 'context-test', name: 'agent-runtime-run',
      status: 'running', createdAt: Date.now(), accepted: true });
    try {
      const receipt = await instance.startRun({ message: 'Correct your earlier statement.', conversationId },
        { userId, creditsRemaining: 999 });
      if ('rejected' in receipt) throw Error(receipt.message);
      await reserveAgentCredits(env, userId, receipt.runId);
      const row = instance.sql`SELECT * FROM agent_runs WHERE id = ${receipt.runId}`[0]!;
      const methods = instance as unknown as {
        readConversationHistory(row: unknown): ConversationTurn[];
        finalizeRun(runId: string, toolCallId: string, input: FinalizeAnswerInput): Promise<AgentTurnResult>;
      };
      expect(methods.readConversationHistory(row)[0]?.evidence?.map(packet => packet.packetId)).toEqual(['frame-proof']);
      expect(() => methods.readConversationHistory({ ...row, user_id: 'other-user' })).toThrow(/parent/);
      const route = JSON.stringify({ route: 'finalize', responseIntent: 'context_answer', reason: 'Correct the earlier roles.' });
      instance.sql`INSERT INTO agent_routes (run_id,decision_json,created_at) VALUES (${receipt.runId},${route},2001)`;
      const input: FinalizeAnswerInput = { intent: 'context_answer', confidence: 'medium', citations: [], artifacts: [], warnings: [],
        answer: 'The woman holds the microphone. [cite:uncited-proof]' };
      await expect(methods.finalizeRun(receipt.runId, 'invalid', input)).rejects.toThrow(/persisted evidence/);
      const result = await methods.finalizeRun(receipt.runId, 'final', { ...input,
        answer: 'The woman holds the microphone. [cite:frame-proof]' });
      expect(result.citations).toEqual([citation]);
      expect(result.billing.creditsCharged).toBe(0);
      expect(instance.sql`SELECT * FROM agent_tool_calls WHERE run_id = ${receipt.runId}`)
        .toMatchObject([{ tool_name: 'finalize_answer', credits: 0 }]);
    } finally { fiber.mockRestore(); }
  });
});

test('terminal run polling settles persisted evidence exactly once', async () => {
  const { runtime, userId, runId } = await seed('agent-settle-runtime');
  expect(await runtime.getRun(runId)).toMatchObject({ status: 'failed', request: { message: 'Private prompt' } });
  expect(await creditBalance(env, userId)).toBe(999);
  await runtime.getRun(runId);
  await runtime.reconcileRun(runId);
  expect(await creditBalance(env, userId)).toBe(999);
});

test('progress restores the persisted phase and tool trace without inference or private diagnostics', async () => {
  const { runtime, runId } = await seed('agent-progress-runtime', 'running');
  await runInDurableObject(runtime, async instance => {
    instance.sql`INSERT INTO agent_events (run_id,type,payload_json,created_at)
      VALUES (${runId},'transcript.diagnostic','invalid private capture',0)`;
  });
  expect(await runtime.getRunProgress(runId)).toMatchObject({ phase: 'research', run: { status: 'running' },
    tools: [{ toolCallId: 'tool', name: 'get_video', status: 'completed' }] });
  expect(await runtime.getRunProgress(crypto.randomUUID())).toBeNull();
  await runtime.reconcileRun(runId);
  expect(await runtime.getRunProgress(runId)).toMatchObject({ phase: 'failed', run: { status: 'failed' } });
});

test('progress restores a persisted draft and cancellation clears it', async () => {
  const { runtime, runId } = await seed('agent-draft-progress-runtime', 'running');
  await runInDurableObject(runtime, async instance => {
    instance.sql`UPDATE agent_runs SET phase = 'finalizing' WHERE id = ${runId}`;
    const writer = instance as unknown as { updateDraft(runId: string, draft: { answer: string; state: 'streaming' }): void };
    writer.updateDraft(runId, { answer: 'A provisional answer', state: 'streaming' });
  });
  expect(await runtime.getRunProgress(runId)).toMatchObject({
    phase: 'finalization', draft: { answer: 'A provisional answer', state: 'streaming' },
  });
  expect(await runtime.cancelRun(runId)).toBe(true);
  expect(await runtime.getRunProgress(runId)).not.toHaveProperty('draft');
  await runInDurableObject(runtime, async instance => {
    expect(instance.sql`SELECT draft_json FROM agent_runs WHERE id = ${runId}`[0]).toEqual({ draft_json: null });
  });
});

test('pre-billing terminal runs are not charged retroactively', async () => {
  const { runtime, userId, runId } = await seed('agent-legacy-runtime');
  await env.DB.prepare('DELETE FROM credit_ledger WHERE user_id = ? AND operation_id = ?')
    .bind(userId, `agent:${runId}`).run();
  await runInDurableObject(runtime, async instance => {
    instance.sql`ALTER TABLE agent_runs DROP COLUMN billing_settled`;
  });
  expect(await runtime.getRun(runId)).toMatchObject({ status: 'failed' });
  expect(await creditBalance(env, userId)).toBe(1000);
});

test.each(['routing', 'executing', 'finalizing'])('migrates an active legacy %s run without restarting its phase clock', async phase => {
  const { runtime, runId } = await seed(`agent-legacy-phase-${phase}`, 'running');
  const createdAt = Date.now() - 30_000;
  const updatedAt = Date.now() - 5_000;
  await runInDurableObject(runtime, async instance => {
    instance.sql`UPDATE agent_runs SET phase = ${phase}, created_at = ${createdAt}, updated_at = ${updatedAt}
      WHERE id = ${runId}`;
    instance.sql`ALTER TABLE agent_runs DROP COLUMN research_deadline_at`;
    instance.sql`ALTER TABLE agent_runs DROP COLUMN finalization_deadline_at`;
    instance.sql`ALTER TABLE agent_runs DROP COLUMN classification_deadline_at`;
    await instance.getRun(runId);
    expect(instance.sql`SELECT research_deadline_at, finalization_deadline_at FROM agent_runs WHERE id = ${runId}`[0])
      .toEqual({ research_deadline_at: phase === 'routing' ? null : createdAt + 40_000,
        finalization_deadline_at: phase === 'finalizing' ? updatedAt + 60_000 : null });
    expect(instance.sql`SELECT classification_deadline_at FROM agent_runs WHERE id = ${runId}`[0])
      .toEqual({ classification_deadline_at: phase === 'routing' ? updatedAt + 20_000 : null });
  });
});

test('recovers a D1 settlement committed before the SQLite checkpoint', async () => {
  const { runtime, userId, runId } = await seed('agent-cross-store-recovery');
  await settleAgentCredits(env, userId, runId, 1, 0);
  await runtime.reconcileRun(runId);
  expect(await creditBalance(env, userId)).toBe(999);
  await runInDurableObject(runtime, async instance => {
    expect(instance.sql`SELECT billing_settled FROM agent_runs WHERE id = ${runId}`[0])
      .toMatchObject({ billing_settled: 1 });
  });
});

test('completed responses use the settled ledger balance, not their admission snapshot', async () => {
  const { runtime, userId, runId, conversationId } = await seed('agent-completed-runtime', 'completed');
  await runInDurableObject(runtime, async instance => {
    const result = JSON.stringify({ runId, conversationId, userMessageId: crypto.randomUUID(),
      agentMessageId: crypto.randomUUID(), intent: 'clarification', answer: 'Which topic?',
      confidence: 'low', citations: [], artifacts: [], warnings: [],
      billing: { creditsCharged: 0, creditsRemaining: 12 } });
    instance.sql`UPDATE agent_runs SET result_json = ${result} WHERE id = ${runId}`;
  });
  // Another account operation consumes credits between admission and settlement.
  await reserveAgentCredits(env, userId, 'another-run');
  expect(await runtime.getRun(runId)).toMatchObject({ result: { billing: {
    creditsCharged: 1, creditsRemaining: 977,
  } } });
});

test('deadline watchdog settles abandoned runs without restarting inference', async () => {
  const { runtime, userId, runId } = await seed('agent-watchdog-runtime', 'running');
  await runtime.reconcileRun(runId);
  expect(await runtime.getRun(runId)).toMatchObject({ status: 'failed' });
  expect(await creditBalance(env, userId)).toBe(999);
});

test('account deletion clears runtime data and rejects delayed admissions', async () => {
  const { runtime, userId, runId, conversationId } = await seed('agent-delete-runtime', 'running');
  await runInDurableObject(runtime, async instance=> {
    await instance.getSessionAssets(conversationId,userId);
    (instance as unknown as {syncSessionHistory():void}).syncSessionHistory();
    instance.sql`INSERT INTO session_run_generations VALUES (${runId},0)`;
  });
  await runtime.deleteAccountData();
  expect(await runtime.getRun(runId)).toBeNull();
  expect(await runtime.getConversation(conversationId, userId)).toBeNull();
  expect(await creditBalance(env, userId)).toBe(999);
  await runInDurableObject(runtime, async instance => {
  await expect(instance.startRun({ message: 'A delayed request', conversationId }, {
    userId, creditsRemaining: 999,
  })).rejects.toThrow('deletion');
  });
  await runtime.deleteAccountData();
  await runInDurableObject(runtime, async (_instance, state) => {
    for (const table of ['agent_runs', 'agent_tool_calls', 'agent_evidence_packets', 'agent_model_usage', 'agent_events', 'cf_agents_fibers', 'session_run_generations', 'session_assets', 'session_memories', 'session_context_fts', 'session_search_assets', 'session_history_index', 'session_history_runs', 'assistant_messages', 'assistant_fts']) {
      expect(state.storage.sql.exec(`SELECT COUNT(*) AS count FROM ${table}`).toArray()[0]).toMatchObject({ count: 0 });
    }
  });
});


test('queued admissions retain their IDs and do not expire before classification starts', async () => {
  const { runtime, userId } = await seed('queued-expired-admission');
  const request = { conversationId: crypto.randomUUID(), message: 'A delayed request' };
  const identity = { runId: crypto.randomUUID(), userMessageId: crypto.randomUUID(), agentMessageId: crypto.randomUUID(), admittedAt: Date.now() - 81_000 };
  await runInDurableObject(runtime, async instance => {
    const fiber = vi.spyOn(instance, 'startFiber').mockResolvedValue({
      fiberId: identity.runId, name: 'agent-runtime-run', status: 'running', createdAt: Date.now(), accepted: true,
    });
    const receipt = await instance.startRun(request, { userId, creditsRemaining: 1000 }, identity);
    expect(receipt).toMatchObject({ request: { message: request.message }, runId: identity.runId, userMessageId: identity.userMessageId, agentMessageId: identity.agentMessageId, status: 'pending' });
    expect(fiber).toHaveBeenCalledOnce();
    fiber.mockRestore();
  });
});

test('an interrupted pending admission retries startup without inserting a duplicate run', async () => {
  const { runtime, userId } = await seed('queued-interrupted-admission');
  const request = { conversationId: crypto.randomUUID(), message: 'An interrupted request' };
  const identity = { runId: crypto.randomUUID(), userMessageId: crypto.randomUUID(), agentMessageId: crypto.randomUUID(), admittedAt: Date.now() };
  await runInDurableObject(runtime, async instance => {
    const fiber = vi.spyOn(instance, 'startFiber').mockRejectedValue(new Error('startup interrupted'));
    const admission = { userId, creditsRemaining: 1000 };
    await expect(instance.startRun(request, admission, identity)).rejects.toThrow('startup interrupted');
    await expect(instance.startRun(request, admission, identity)).rejects.toThrow('startup interrupted');
    expect(fiber).toHaveBeenCalledTimes(2);
    expect(instance.sql`SELECT id FROM agent_runs WHERE conversation_id = ${request.conversationId}`).toEqual([{ id: identity.runId }]);
    expect(fiber.mock.calls[0]?.[2]).not.toHaveProperty('idempotencyKey');
    expect(fiber.mock.calls[0]?.[2]?.fiberId).toBe(identity.runId);
    fiber.mockRestore();
  });
});

test('keyless follow-ups create new runs while an active session still rejects overlapping work', async () => {
  const { runtime, userId, conversationId } = await seed('keyless-followups');
  await runInDurableObject(runtime, async instance => {
    const fiber = vi.spyOn(instance, 'startFiber').mockResolvedValue({
      fiberId: 'stub', name: 'agent-runtime-run', status: 'running', createdAt: Date.now(), accepted: true,
    });
    const request = { conversationId, message: 'Research five videos' };
    const admission = { userId, creditsRemaining: 1000 };
    const first = await instance.startRun(request, admission);
    if ('rejected' in first) throw new Error(first.message);
    expect(await instance.startRun(request, admission)).toMatchObject({ rejected: true, code: 'AGENT_CONVERSATION_BUSY' });
    instance.sql`UPDATE agent_runs SET status = 'failed', billing_settled = 1 WHERE id = ${first.runId}`;
    const second = await instance.startRun(request, admission);
    if ('rejected' in second) throw new Error(second.message);
    expect(second.runId).not.toBe(first.runId);
    expect(second.conversationId).toBe(first.conversationId);
    expect(fiber).toHaveBeenCalledTimes(2);
    for (const call of fiber.mock.calls) expect(call[2]).not.toHaveProperty('idempotencyKey');
    fiber.mockRestore();
  });
});

test('saves a ready answer and settles it idempotently', async () => {
  const { runtime, runId, userId } = await seed('agent-save-outside-model-window', 'running');
  await runInDurableObject(runtime, async instance => {
    const decision = JSON.stringify({ route: 'clarification', question: 'Which topic?' });
    instance.sql`INSERT INTO agent_routes (run_id,decision_json,created_at) VALUES (${runId},${decision},0)`;
    // Exercise the internal saving boundary with a run older than either model window.
    const saving = instance as unknown as {
      finalizeRun: (runId: string, toolId: string, input: import('../src/agents/contracts').FinalizeAnswerInput) => Promise<unknown>;
    };
    await saving.finalizeRun(runId, 'answer', { answer: 'Which topic?', intent: 'clarification',
      confidence: 'low', citations: [], artifacts: [], warnings: [] });
  });
  expect(await runtime.getRun(runId)).toMatchObject({ status: 'completed' });
  await runtime.reconcileRun(runId);
  expect(await creditBalance(env, userId)).toBe(999);
});


test('a stale admission watchdog does not cancel classification or active phase budgets', async () => {
  const { runtime, runId } = await seed('agent-phase-watchdog-runtime', 'running');
  await runInDurableObject(runtime, async instance => {
    instance.sql`UPDATE agent_runs SET phase = 'routing', research_deadline_at = null,
      classification_deadline_at = ${Date.now() + 20_000} WHERE id = ${runId}`;
  });
  await runtime.reconcileRun(runId);
  expect(await runtime.getRun(runId)).toMatchObject({ status: 'running' });
  await runInDurableObject(runtime, async instance => {
    instance.sql`UPDATE agent_runs SET phase = 'executing', research_deadline_at = ${Date.now() + 40_000} WHERE id = ${runId}`;
  });
  await runtime.reconcileRun(runId);
  expect(await runtime.getRun(runId)).toMatchObject({ status: 'running' });
  await runInDurableObject(runtime, async instance => {
    instance.sql`UPDATE agent_runs SET phase = 'finalizing', research_deadline_at = 0,
      finalization_deadline_at = ${Date.now() + 40_000} WHERE id = ${runId}`;
  });
  await runtime.reconcileRun(runId);
  expect(await runtime.getRun(runId)).toMatchObject({ status: 'running' });
  // Saving a ready answer has its own allowance after model generation ends.
  await runInDurableObject(runtime, async instance => {
    instance.sql`UPDATE agent_runs SET finalization_deadline_at = ${Date.now() - 5_000} WHERE id = ${runId}`;
  });
  await runtime.reconcileRun(runId);
  expect(await runtime.getRun(runId)).toMatchObject({ status: 'running' });
  await runInDurableObject(runtime, async instance => {
    instance.sql`UPDATE agent_runs SET finalization_deadline_at = ${Date.now() - 31_000} WHERE id = ${runId}`;
  });
  await runtime.reconcileRun(runId);
  expect(await runtime.getRun(runId)).toMatchObject({ status: 'failed' });
});

test('persists phase deadlines once so recovery cannot extend them', async () => {
  const { runtime, runId } = await seed('agent-phase-persistence-runtime', 'running');
  await runInDurableObject(runtime, async instance => {
    instance.sql`UPDATE agent_runs SET phase = 'routing', research_deadline_at = null WHERE id = ${runId}`;
    const phases = instance as unknown as {
      updatePhase: (runId: string, phase: 'routing' | 'executing' | 'finalizing', deadlineAt: number) => Promise<void>;
    };
    const classificationDeadline = Date.now() + 20_000;
    await phases.updatePhase(runId, 'routing', classificationDeadline);
    await phases.updatePhase(runId, 'routing', classificationDeadline + 20_000);
    expect(instance.sql`SELECT classification_deadline_at FROM agent_runs WHERE id = ${runId}`[0])
      .toEqual({ classification_deadline_at: classificationDeadline });
    const researchDeadline = Date.now() + 40_000;
    await phases.updatePhase(runId, 'executing', researchDeadline);
    await phases.updatePhase(runId, 'executing', researchDeadline + 20_000);
    const finalizationDeadline = Date.now() + 60_000;
    await phases.updatePhase(runId, 'finalizing', finalizationDeadline);
    await phases.updatePhase(runId, 'finalizing', finalizationDeadline + 20_000);
    expect(instance.sql`SELECT phase, research_deadline_at, finalization_deadline_at FROM agent_runs WHERE id = ${runId}`[0])
      .toEqual({ phase: 'finalizing', research_deadline_at: researchDeadline, finalization_deadline_at: finalizationDeadline });
  });
});

test('settles abandoned classification once its saved deadline and persistence allowance expire', async () => {
  const { runtime, runId } = await seed('agent-classification-watchdog', 'running');
  await runInDurableObject(runtime, async instance => {
    instance.sql`UPDATE agent_runs SET phase = 'routing', research_deadline_at = null,
      classification_deadline_at = ${Date.now() - 31_000} WHERE id = ${runId}`;
  });
  await runtime.reconcileRun(runId);
  expect(await runtime.getRun(runId)).toMatchObject({ status: 'failed' });
});

test('persists an out-of-scope rejection and refunds the evidence credit reservation', async () => {
  const { runtime, runId, userId } = await seed('agent-rejected-runtime', 'running');
  await runInDurableObject(runtime, async instance => {
    instance.sql`DELETE FROM agent_tool_calls WHERE run_id = ${runId}`;
    const decision = JSON.stringify({ route: 'rejected', reason: 'Bookings are outside YouTube video synthesis.' });
    instance.sql`INSERT INTO agent_routes (run_id,decision_json,created_at) VALUES (${runId},${decision},0)`;
    const saving = instance as unknown as {
      finalizeRun: (runId: string, toolId: string, input: import('../src/agents/contracts').FinalizeAnswerInput) => Promise<unknown>;
    };
    await saving.finalizeRun(runId, 'rejection', { answer: 'I can synthesize YouTube videos, but cannot make bookings.',
      intent: 'rejected', confidence: 'low', citations: [], artifacts: [],
      warnings: [{ code: 'OUT_OF_SCOPE', message: 'Bookings are outside YouTube video synthesis.' }] });
  });
  expect(await runtime.getRun(runId)).toMatchObject({ status: 'completed', route: { route: 'rejected' },
    result: { intent: 'rejected', citations: [], billing: { creditsCharged: 0, creditsRemaining: 1000 } } });
  expect(await creditBalance(env, userId)).toBe(1000);
});

test('persists private transcript rejection details and retrieves only this run diagnostics', async () => {
  const { runtime, runId } = await seed('agent-transcript-diagnostics');
  const attemptId = crypto.randomUUID();
  await runInDurableObject(runtime, async instance => {
    const writer = instance as unknown as { recordTranscriptDiagnostic(runId: string, event: import('../src/agents/runtime/transcript-diagnostics').TranscriptDiagnostic): void };
    const event = { version: 1 as const, stage: 'transcript_analysis' as const, videoId: 'abcdefghijk',
      modelCallId: 'analyst:tool', attemptId, attempt: 1, recordedAt: 10, outcome: 'rejected' as const,
      elapsedMs: 15000, code: 'GROUNDING_REJECTED' as const,
      repairFeedback: 'Unsupported entity PrivateName', rejectedOutput: 'Private rejected model content',
      issues: [{ code: 'ENTITY_NOT_SUPPORTED' as const, findingIndex: 0, fieldIndex: 0, message: 'Private diagnostic detail' }] };
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    writer.recordTranscriptDiagnostic(runId, event);
    writer.recordTranscriptDiagnostic(crypto.randomUUID(), { ...event, rejectedOutput: 'Other run content' });
    const logs = JSON.stringify(log.mock.calls);
    expect(logs).toContain('ENTITY_NOT_SUPPORTED');
    expect(logs).not.toContain('PrivateName');
    expect(logs).not.toContain('Private rejected model content');
    expect(logs).not.toContain('Private diagnostic detail');
    log.mockRestore();
  });
  // A separate RPC reads the persisted event, with no in-memory callback or active model needed.
  const first = await runtime.getRun(runId) as import('../src/agents/agent-runtime-do').AgentRunView | null;
  const second = await runtime.getRun(runId) as import('../src/agents/agent-runtime-do').AgentRunView | null;
  expect(first?.transcriptDiagnostics).toHaveLength(1);
  expect(second?.transcriptDiagnostics).toEqual(first?.transcriptDiagnostics);
  expect(second?.transcriptDiagnostics?.[0]).toMatchObject({ attemptId,
    repairFeedback: 'Unsupported entity PrivateName', rejectedOutput: 'Private rejected model content' });
});

test('retry admission preserves the failed request, original display text, and stable context', async () => {
  const { runtime, userId, runId, conversationId } = await seed('agent-retry-context');
  await runInDurableObject(runtime, async instance => {
    const fiber = vi.spyOn(instance, 'startFiber').mockResolvedValue({
      fiberId: 'retry-test', name: 'agent-runtime-run', status: 'running', createdAt: Date.now(), accepted: true,
    });
    const admission = { userId, creditsRemaining: 999 };
    const receipt = await instance.startRun({ message: 'try again', conversationId }, admission);
    expect(receipt).not.toHaveProperty('rejected');
    if ('rejected' in receipt) return;
    expect(receipt.request).toEqual({ message: 'try again' });
    expect(instance.sql`SELECT message, execution_message, parent_message_id FROM agent_runs WHERE id = ${receipt.runId}`[0])
      .toEqual({ message: 'try again', execution_message: 'Private prompt', parent_message_id: null });
    instance.sql`UPDATE agent_runs SET status = 'failed' WHERE id = ${receipt.runId}`;
    const second = await instance.startRun({ message: 'Please try again.', conversationId }, admission);
    if ('rejected' in second) throw Error(second.message);
    expect(instance.sql`SELECT execution_message FROM agent_runs WHERE id = ${second.runId}`[0])
      .toEqual({ execution_message: 'Private prompt' });
    const repeated = await instance.startRun({ message: 'try again', conversationId }, admission);
    expect(repeated).toMatchObject({ rejected: true, code: 'AGENT_CONVERSATION_BUSY' });
    expect(instance.sql`SELECT id FROM agent_runs WHERE conversation_id = ${conversationId}`).toHaveLength(3);
    // The original remains intact, and the failed assistant is never a memory parent.
    expect(instance.sql`SELECT message FROM agent_runs WHERE id = ${runId}`[0]).toEqual({ message: 'Private prompt' });
    fiber.mockRestore();
  });
});

test('does not reinterpret a new task or a retry in another session as the failed request', async () => {
  const { runtime, userId, conversationId } = await seed('agent-retry-isolation');
  await runInDurableObject(runtime, async instance => {
    const fiber = vi.spyOn(instance, 'startFiber').mockResolvedValue({
      fiberId: 'isolation-test', name: 'agent-runtime-run', status: 'running', createdAt: Date.now(), accepted: true,
    });
    for (const [message, session] of [['try again with a different video', conversationId], ['try again', crypto.randomUUID()]]) {
      const receipt = await instance.startRun({ message: message!, conversationId: session! },
        { userId, creditsRemaining: 999 });
      if ('rejected' in receipt) throw Error(receipt.message);
      expect(instance.sql`SELECT execution_message FROM agent_runs WHERE id = ${receipt.runId}`[0])
        .toEqual({ execution_message: null });
    }
    fiber.mockRestore();
  });
});

test('legacy retry chains keep their original branch and completed retries remember the effective request', async () => {
  const { runtime, userId, runId, conversationId } = await seed('agent-legacy-retry');
  await runInDurableObject(runtime, async instance => {
    const parentId = crypto.randomUUID();
    // The failed request belongs to a valid completed branch.
    const result = JSON.stringify({ runId: crypto.randomUUID(), conversationId, userMessageId: crypto.randomUUID(),
      agentMessageId: parentId, intent: 'clarification', answer: 'Which comparison?',
      confidence: 'low', citations: [], artifacts: [], warnings: [], billing: { creditsCharged: 0, creditsRemaining: 999 } });
    instance.sql`INSERT INTO agent_runs (id,user_id,conversation_id,user_message_id,agent_message_id,
      turn_ordinal,message,status,phase,result_json,credits_remaining_at_admission,created_at,updated_at)
      VALUES ('parent',${userId},${conversationId},${crypto.randomUUID()},${parentId},0,'Earlier request','completed','completed',${result},999,0,0)`;
    instance.sql`UPDATE agent_runs SET message = 'Summarize https://youtu.be/abcdefghijk', parent_message_id = ${parentId} WHERE id = ${runId}`;
    const legacyId = crypto.randomUUID();
    instance.sql`INSERT INTO agent_runs (id,user_id,conversation_id,parent_message_id,user_message_id,agent_message_id,
      turn_ordinal,message,status,phase,credits_remaining_at_admission,created_at,updated_at)
      VALUES (${legacyId},${userId},${conversationId},${parentId},${crypto.randomUUID()},${crypto.randomUUID()},2,'try again','failed','failed',999,1,1)`;
    const fiber = vi.spyOn(instance, 'startFiber').mockResolvedValue({
      fiberId: 'legacy-retry', name: 'agent-runtime-run', status: 'running', createdAt: Date.now(), accepted: true,
    });
    const receipt = await instance.startRun({ message: 'retry', conversationId },
      { userId, creditsRemaining: 999 });
    if ('rejected' in receipt) throw Error(receipt.message);
    const row = instance.sql`SELECT * FROM agent_runs WHERE id = ${receipt.runId}`[0]!;
    expect(row).toMatchObject({ execution_message: 'Summarize https://youtu.be/abcdefghijk', parent_message_id: parentId });
    const saved = JSON.stringify({ ...JSON.parse(result), runId: receipt.runId, userMessageId: receipt.userMessageId,
      agentMessageId: receipt.agentMessageId, answer: 'A summary.' });
    instance.sql`UPDATE agent_runs SET status = 'completed', result_json = ${saved} WHERE id = ${receipt.runId}`;
    const memory = instance as unknown as { readConversationHistory(row: unknown): import('../src/agents/runtime/conversation-memory').ConversationTurn[] };
    expect(memory.readConversationHistory({ ...row, parent_message_id: receipt.agentMessageId }).at(-1))
      .toMatchObject({ user: 'Summarize https://youtu.be/abcdefghijk', assistant: 'A summary.', resourceIds: ['abcdefghijk'] });
    fiber.mockRestore();
  });
});


test('deduplicates complete transcript retrieval durably across focuses and keeps language requests separate', async () => {
  const { runtime, runId } = await seed('direct-transcript-reuse', 'running');
  for (const [callId, language] of [['first', 'en'], ['rephrased', 'en'], ['translated', 'fr']] as const) {
    await runInDurableObject(runtime, async instance => {
      const persisted = instance as unknown as { executeEvidenceTool(runId: string, execution: EvidenceToolExecution): Promise<EvidencePacket> };
      const transcript = vi.fn(async () => ({ cacheStatus: 'miss' as const, value: {
        videoId: 'abcdefghijk', track: { id: language, name: language, languageCode: language, kind: 'manual' as const, isTranslatable: true, isDefault: true },
        segments: [{ startMs: 0, endMs: 1000, durationMs: 1000, text: `Caption ${language}` }], text: `Caption ${language}`,
        meta: { source: 'allthingsyoutube' as const, fetchedAt: new Date().toISOString(), partial: false, warnings: [] },
      } }));
      const context = {
        runId, signal: new AbortController().signal, transcriptPolicy: { mode: 'complete_transcript' },
        provider: { transcript } as unknown as AgentToolContext['provider'], finalize: vi.fn(), executeEvidenceTool: execution => persisted.executeEvidenceTool(runId, execution),
      } as AgentToolContext;
      const packet = await executeGetVideoTranscript({ videoId: 'abcdefghijk', language, focus: callId }, context, callId);
      expect(packet.excerpts[0]!.text).toBe(`Caption ${language}`);
      expect(transcript).toHaveBeenCalledTimes(callId === 'rephrased' ? 0 : 1);
    });
  }
  await runInDurableObject(runtime, async instance => {
    const calls = instance.sql<{ credits: number }>`SELECT credits FROM agent_tool_calls WHERE run_id = ${runId} AND tool_name = 'get_video_transcript'`;
    expect(calls).toHaveLength(2);
    expect(calls.reduce((sum, call) => sum + call.credits, 0)).toBe(2);
    expect(instance.sql`SELECT * FROM agent_evidence_packets WHERE run_id = ${runId}`).toHaveLength(2);
  });
});

test('session assets enforce ownership and deletion removes run copies, citations and memory', async()=> {
  const {runtime,runId,userId,conversationId}=await seed('session-asset-owner','running');
  let version='';
  let sharedReference: import('../src/lib/video-catalog').VideoAssetReference;
  await runInDurableObject(runtime,async (instance,state)=>{
    const {SessionEvidenceStore}=await import('../src/agents/runtime/session-evidence');
    const store=(instance as unknown as {sessionStore:InstanceType<typeof SessionEvidenceStore>}).sessionStore;
    const raw=await store.retrieve('transcript:abcdefghijk:default','transcript','abcdefghijk',false,async()=>({value:{videoId:'abcdefghijk',text:'Private captions',segments:[{text:'Private captions',startMs:0,endMs:1000,durationMs:1000}]},cacheStatus:'miss'}),()=>({complete:true}));
    version=raw.assetVersions![0]!;
    sharedReference=JSON.parse(state.storage.sql.exec<{reference_json:string}>('SELECT reference_json FROM session_asset_catalog_refs WHERE version=?',version).one().reference_json).asset;
    const writer=instance as unknown as {performEvidenceTool(runId:string,execution:EvidenceToolExecution):Promise<EvidencePacket>;finalizeRun(runId:string,toolId:string,input:FinalizeAnswerInput):Promise<AgentTurnResult>};
    const packet=await writer.performEvidenceTool(runId,{toolCallId:'transcript',toolName:'get_video_transcript',semanticKey:'transcript',operation:'transcript',input:{videoId:'abcdefghijk'},execute:async()=>({packetId:'stored-private',kind:'youtube_transcript',assetVersions:[version],sources:[{id:'source',provider:'youtube',kind:'transcript',videoId:'abcdefghijk'}],excerpts:[{id:'legacy',sourceId:'source',text:'Private captions'}],artifacts:[],warnings:[],usage:[]})});
    instance.sql`INSERT INTO agent_routes VALUES (${runId},${JSON.stringify({route:'finalize',responseIntent:'context_answer',reason:'Stored evidence'})},0)`;
    await writer.finalizeRun(runId,'finish',{intent:'context_answer',answer:`A caption [cite:${packet.excerpts[0]!.id}]`,confidence:'high',citations:[],artifacts:[],warnings:[],
      memoryUpdates:[{kind:'finding',topic:'caption',text:'A finding',evidenceIds:[packet.excerpts[0]!.id]}]});
    expect(store.brief().memories).toHaveLength(1);
  });
  expect(await runtime.getSessionAssets(conversationId,'different-user')).toBeNull();
  expect((await runtime.getSessionAssets(conversationId,userId))?.assets).toHaveLength(1);
  expect(await runtime.getSessionAsset(conversationId,userId,version)).toMatchObject({text:'Private captions'});
  await runtime.deleteSessionAssets(conversationId,userId,version);
  expect(await runtime.getSessionAsset(conversationId,userId,version)).toBeNull();
  const {VideoCatalog}=await import('../src/lib/video-catalog');
  expect(await new VideoCatalog(env.VIDEO_CATALOG,env.VIDEO_ASSETS).readVersion(sharedReference!)).toMatchObject({value:{text:'Private captions'}});
  expect((await runtime.getSessionAssets(conversationId,userId))?.memories).toEqual([]);
  await runInDurableObject(runtime,async instance=>{
    expect(instance.sql`SELECT * FROM agent_evidence_packets`).toEqual([]);
    expect(JSON.stringify(instance.sql`SELECT result_json FROM agent_tool_calls`)).not.toContain('Private captions');
    const run=await instance.getRun(runId);
    expect(run?.result?.citations).toEqual([]);
    expect(run?.result?.answer).toContain('[source deleted]');
    const {SessionEvidenceStore}=await import('../src/agents/runtime/session-evidence');
    const store=(instance as unknown as {sessionStore:InstanceType<typeof SessionEvidenceStore>}).sessionStore;
    expect(await store.search.searchHistory('A caption')).toEqual([]);
    expect((await store.search.searchEvidence(store,'Private captions')).packets).toEqual([]);
  });
});


test('persisting a finalizer escalation clears phase deadlines before a restart can observe the new route',async()=>{
  const {runtime,runId}=await seed('escalation-recovery','running');
  await runInDurableObject(runtime,async instance=>{
    instance.sql`INSERT INTO agent_routes VALUES (${runId},${JSON.stringify({route:'finalize',responseIntent:'context_answer',reason:'Use existing evidence'})},0)`;
    instance.sql`UPDATE agent_runs SET finalization_deadline_at=123,research_deadline_at=456 WHERE id=${runId}`;
    const writer=instance as unknown as {persistRoute(runId:string,decision:unknown):void};
    writer.persistRoute(runId,{route:'inspect_video',videoId:'abcdefghijk',useStoryboard:true});
    expect(instance.sql`SELECT finalization_deadline_at,research_deadline_at FROM agent_runs WHERE id=${runId}`[0]).toEqual({finalization_deadline_at:null,research_deadline_at:null});
    expect(JSON.parse(instance.sql<{decision_json:string}>`SELECT decision_json FROM agent_routes WHERE run_id=${runId}`[0]!.decision_json)).toMatchObject({route:'inspect_video'});
  });
});

test('backfills original messages including failed retries into Session history without restoring deleted answers',async()=>{
  const {runtime,runId,userId,conversationId}=await seed('session-history-backfill','failed');
  await runInDurableObject(runtime,async(instance)=>{
    const {SessionEvidenceStore}=await import('../src/agents/runtime/session-evidence');
    const writer=instance as unknown as {syncSessionHistory():void;sessionStore:InstanceType<typeof SessionEvidenceStore>};
    instance.sql`UPDATE agent_runs SET message='Please try again.',execution_message='Original enterprise pricing request' WHERE id=${runId}`;
    const aid=crypto.randomUUID(),uid=crypto.randomUUID();
    const result=JSON.stringify({runId:crypto.randomUUID(),conversationId,userMessageId:uid,agentMessageId:aid,intent:'context_answer',answer:'An obsolete pricing conclusion.',confidence:'high',citations:[],artifacts:[],
      warnings:[{code:'SESSION_EVIDENCE_DELETED',message:'Source removed'}],billing:{creditsCharged:0,creditsRemaining:99}});
    instance.sql`INSERT INTO agent_runs (id,user_id,conversation_id,user_message_id,agent_message_id,turn_ordinal,message,status,phase,result_json,credits_remaining_at_admission,created_at,updated_at)
      VALUES ('older',${userId},${conversationId},${uid},${aid},0,'Discuss enterprise pricing.','completed','completed',${result},100,0,0)`;
    writer.syncSessionHistory();
    expect(writer.sessionStore.search.readHistory(0,'user').messages.map(message=>message.text)).toEqual(['Discuss enterprise pricing.','Please try again.']);
    expect(await writer.sessionStore.search.searchHistory('obsolete')).toEqual([]);
    expect(await writer.sessionStore.search.searchHistory('Original enterprise')).toEqual([]);
    expect((await writer.sessionStore.search.searchHistory('enterprise pricing'))).toHaveLength(1);
    writer.syncSessionHistory();
    expect(writer.sessionStore.search.readHistory().messages).toHaveLength(2);
  });
});


test('restores display citations consistently without rewriting canonical answers or user text', async () => {
  const { runtime, runId, conversationId, userId } = await seed('restore-display-citations', 'completed');
  await runInDurableObject(runtime, async instance => {
    const row = instance.sql`SELECT * FROM agent_runs WHERE id = ${runId}`[0]!;
    const answer = '**Saved observation** [cite:frame:1] [cite:frame:2]\n\nSecond paragraph [cite:frame:1].';
    const result: AgentTurnResult = { runId, conversationId, userMessageId: String(row.user_message_id),
      agentMessageId: String(row.agent_message_id), intent: 'inspect_video', answer, confidence: 'medium',
      citations: ['frame:1', 'frame:2'].map(id => ({ id, sourceId: 'frames', provider: 'youtube',
        videoId: 'abcdefghijk', title: 'Saved video', excerpt: 'A person is visible.' })),
      artifacts: [], warnings: [], billing: { creditsCharged: 1, creditsRemaining: 999 } };
    const literalUser = 'Explain the literal token [cite:example].';
    instance.sql`UPDATE agent_runs SET result_json = ${JSON.stringify(result)}, message = ${literalUser} WHERE id = ${runId}`;
    const page = await instance.getConversation(conversationId, userId);
    expect(page?.messages.find(message => message.role === 'user')?.content).toBe(literalUser);
    const display = page?.messages.find(message => message.role === 'assistant')?.content;
    expect(display).toBe('**Saved observation** [1]\n\nSecond paragraph [1].');
    const progress = await instance.getRunProgress(runId);
    expect(display).toBe(progress?.run.result?.answer);
    expect((await instance.getRun(runId))?.result?.answer).toBe(answer);
    expect(JSON.parse(String(instance.sql`SELECT result_json FROM agent_runs WHERE id = ${runId}`[0]!.result_json)).answer).toBe(answer);
  });
});

test('persists retrieval and analysis with separate bounded quotas and settles only retrieval credits', async () => {
  const {runtime,runId}=await seed('separate-analysis-quota','running');
  await runInDurableObject(runtime,async instance=>{
    const writer=instance as unknown as {
      performEvidenceTool(runId:string,execution:EvidenceToolExecution):Promise<EvidencePacket>;
      finalizeRun(runId:string,toolId:string,input:FinalizeAnswerInput):Promise<AgentTurnResult>;
    };
    const execute=(n:number,analysis:boolean)=>writer.performEvidenceTool(runId,{
      toolCallId:`${analysis?'analysis':'retrieval'}-${n}`,toolName:analysis?'analyze_video_transcript':'get_video_transcript',
      semanticKey:`${analysis?'analysis':'retrieval'}:${n}`,operation:'transcript',input:{videoId:'abcdefghijk'},
      execute:async()=>({packetId:`packet:${runId}:${analysis?'analysis':'retrieval'}-${n}`,kind:'youtube_transcript',
        sources:[{id:'source',provider:'youtube',kind:'transcript',videoId:'abcdefghijk'}],
        excerpts:analysis?[{id:`finding-${n}`,sourceId:'source',text:'A supported finding.'}]:[],artifacts:[],warnings:[],
        usage:analysis?[]:[{operation:'transcript',cacheStatus:'miss',credits:1}]}),
    });
    // seed already recorded one provider call. Fill its quota, then analyze saved content.
    for(let n=0;n<10;n++) await execute(n,false);
    await expect(execute(10,false)).rejects.toThrow('budget is exhausted');
    let citation = '';
    for(let n=0;n<11;n++) {const packet=await execute(n,true);citation ||= packet.excerpts[0]!.id;}
    await expect(execute(11,true)).rejects.toThrow('budget is exhausted');
    instance.sql`INSERT INTO agent_routes VALUES (${runId},${JSON.stringify({route:'topic_research'})},0)`;
    const result=await writer.finalizeRun(runId,'finish',{intent:'topic_research',answer:`A supported finding. [cite:${citation}]`,confidence:'high',citations:[],artifacts:[],warnings:[]});
    expect(result.billing.creditsCharged).toBe(11);
    expect(instance.sql`SELECT * FROM agent_tool_calls WHERE run_id=${runId} AND tool_name='analyze_video_transcript' AND credits=0`).toHaveLength(11);
  });
});

test('operator asset migration RPC enforces session ownership and verifies dormant legacy assets', async () => {
  const { runtime, userId, conversationId } = await seed('operator-session-owner');
  let version = '';
  await runInDurableObject(runtime, async (_instance, state) => {
    const { SessionEvidenceStore } = await import('../src/agents/runtime/session-evidence');
    const legacy = new SessionEvidenceStore(state.storage.sql, env.RESEARCH, 'operator-rpc/');
    const saved = await legacy.retrieve('transcript:abcdefghijk:default', 'transcript', 'abcdefghijk', false,
      async () => ({ value: { videoId: 'abcdefghijk', text: 'Saved captions', segments: [] }, cacheStatus: 'miss' }), () => ({}));
    version = saved.assetVersions![0]!;
  });
  expect(await runtime.migrateSessionAssets(conversationId, 'different-user', { mode: 'migrate' })).toBeNull();
  expect(await runtime.migrateSessionAssets(crypto.randomUUID(), userId, { mode: 'migrate' })).toBeNull();
  expect((await runtime.migrateSessionAssets(conversationId, userId, { mode: 'verify' }))?.results)
    .toEqual([{ version, status: 'unlinked', migrated: false }]);
  expect((await runtime.migrateSessionAssets(conversationId, userId, { mode: 'migrate' }))?.results)
    .toEqual([{ version, status: 'shared_verified', migrated: true }]);
  expect((await runtime.migrateSessionAssets(conversationId, userId, { mode: 'verify' }))?.results)
    .toEqual([{ version, status: 'shared_verified', migrated: false }]);
  expect(await runtime.getSessionAsset(conversationId, userId, version)).toMatchObject({ text: 'Saved captions' });
});

test('inspects complete persisted tool inputs and outputs after RPC restoration', async () => {
  const { runtime, runId, userId } = await seed('complete-tool-trace', 'running');
  const input = { videoId: 'abcdefghijk', focus: 'x'.repeat(1500), options: { offsets: Array.from({ length: 30 }, (_, i) => i) } };
  const packet: EvidencePacket = { packetId: 'full-trace-packet', kind: 'youtube_transcript',
    sources: [{ id: 'source', provider: 'youtube', kind: 'transcript', videoId: input.videoId }],
    excerpts: Array.from({ length: 200 }, (_, i) => ({ id: `excerpt-${i}`, sourceId: 'source', text: 'complete output '.repeat(100) })),
    artifacts: [], warnings: [], usage: [] };
  const returned=await runInDurableObject(runtime, async instance => {
    const methods = instance as unknown as {
      executeEvidenceTool(runId: string, execution: EvidenceToolExecution & { input: unknown }): Promise<EvidencePacket>;
    };
    return methods.executeEvidenceTool(runId, { toolCallId: 'full-call', toolName: 'get_video_transcript',
      operation: 'transcript', semanticKey: `transcript:${JSON.stringify({ videoId: input.videoId })}`, input,
      execute: async () => packet });
  });
  await runtime.retryTraceIndex();
  const row=await env.DB.prepare('SELECT trace_id FROM agent_tool_traces WHERE run_id=? AND tool_call_id=?')
    .bind(runId,'full-call').first<{trace_id:string}>();
  expect(row).not.toBeNull();
  const trace=await readAdminToolTrace(env,runId,row!.trace_id);
  expect(trace).toMatchObject({toolCallId:'full-call',input,status:'completed',payloadState:'complete'});
  expect(JSON.stringify(trace?.output)===JSON.stringify(returned)).toBe(true);
  expect(JSON.stringify(await runtime.getRunProgress(runId))).not.toContain(input.focus);
});

test('trace history retains repeated attempts, exact model results and parallel event ordering', async () => {
  const {runtime,runId}=await seed('trace-attempt-history','running');
  await runInDurableObject(runtime,async instance=>{
    const manager=(instance as unknown as {traceManager:import('../src/agents/runtime/tool-call-trace').ToolCallTraceManager}).traceManager;
    const input={query:'complete argument',nested:{ids:Array.from({length:40},(_,i)=>i)}};
    const first=await manager.track(runId,{toolCallId:'same-id',name:'research_video_transcripts',operation:'research',source:'model',input,
      execute:async()=>manager.track(runId,{toolCallId:'same-id',name:'internal',operation:'transcript',input:{different:true},execute:async()=>({answer:'exact model result',nested:[{all:true}]})})});
    expect(first.answer).toBe('exact model result');
    await manager.track(runId,{toolCallId:'same-id',name:'research_video_transcripts',operation:'research',source:'model',input:{retry:true},execute:async()=>({answer:'second result'})});
    const error=Object.assign(new Error('The provider failed.'),{code:'PROVIDER_UNAVAILABLE',headers:{authorization:'SECRET'}});
    await expect(manager.track(runId,{toolCallId:'failed-id',name:'read_session_evidence',operation:'context',input:{version:'v1'},execute:async()=>{throw error;}})).rejects.toBe(error);
    await Promise.all(['parallel-a','parallel-b'].map(toolCallId=>manager.track(runId,{toolCallId,name:'context_read',operation:'context',input:{toolCallId},execute:async()=>({toolCallId})})));
    await manager.publishPending();
    const rows=await env.DB.prepare('SELECT * FROM agent_tool_traces WHERE run_id=? ORDER BY call_sequence').bind(runId).all<import('../src/agents/runtime/admin-tool-traces').AdminTraceRow>();
    expect(rows.results).toHaveLength(5);
    const attempts=rows.results.filter(row=>row.tool_call_id==='same-id');
    expect(attempts.map(row=>row.attempt)).toEqual([1,2]);
    const detail=await readAdminToolTrace(env,runId,attempts[0]!.trace_id);
    expect(detail?.input).toEqual(input);
    expect(detail?.output).toEqual(first);
    const failed=await readAdminToolTrace(env,runId,rows.results.find(row=>row.tool_call_id==='failed-id')!.trace_id);
    expect(failed?.error).toEqual({name:'Error',message:error.message,code:error.code});
    expect(JSON.stringify(failed)).not.toContain('SECRET');
    const sequences=rows.results.flatMap(row=>[row.call_sequence,row.result_sequence!]).sort((a,b)=>a-b);
    expect(sequences).toEqual(Array.from({length:10},(_,i)=>i+1));
  });
});

test('diagnostic storage failures preserve tool behavior and pending D1 writes retry', async () => {
  const {runtime,runId}=await seed('trace-storage-failure','running');
  await runInDurableObject(runtime,async instance=>{
    const manager=(instance as unknown as {traceManager:import('../src/agents/runtime/tool-call-trace').ToolCallTraceManager}).traceManager;
    const prepare=env.DB.prepare.bind(env.DB);
    const log=vi.spyOn(console,'error').mockImplementation(()=>{});
    const db=vi.spyOn(env.DB,'prepare').mockImplementation(sql=>{
      if (sql.startsWith('INSERT INTO agent_tool_traces')) throw new Error('D1 unavailable');
      return prepare(sql);
    });
    try {
      expect(await manager.track(runId,{toolCallId:'retry-index',name:'read_session_history',operation:'context',input:{offset:0},execute:async()=>({messages:['saved history']})})).toEqual({messages:['saved history']});
      await manager.publishPending();
      expect(instance.sql`SELECT index_pending FROM agent_call_traces`[0]!.index_pending).toBe(1);
    } finally {db.mockRestore();}
    await manager.publishPending();
    const indexed=await env.DB.prepare('SELECT * FROM agent_tool_traces WHERE run_id=?').bind(runId).first<import('../src/agents/runtime/admin-tool-traces').AdminTraceRow>();
    expect(indexed?.status).toBe('completed');
    const storage=vi.spyOn(env.RESEARCH,'put').mockRejectedValue(new Error('R2 unavailable'));
    try {
      expect(await manager.track(runId,{toolCallId:'missing-blob',name:'search_context',operation:'context',input:{query:'secret context'},execute:async()=>({matches:['secret result']})})).toEqual({matches:['secret result']});
      await manager.publishPending();
      expect(instance.sql`SELECT COUNT(*) AS count FROM agent_trace_payload_chunks`[0]!.count).toBeGreaterThan(0);
    } finally {storage.mockRestore();}
    const row=await env.DB.prepare('SELECT trace_id FROM agent_tool_traces WHERE run_id=? AND tool_call_id=?').bind(runId,'missing-blob').first<{trace_id:string}>();
    expect(await readAdminToolTrace(env,runId,row!.trace_id)).toMatchObject({status:'completed',payloadState:'unavailable',captureError:'OUTPUT_STORAGE_FAILED'});
    await manager.publishPending();
    expect(await readAdminToolTrace(env,runId,row!.trace_id)).toMatchObject({status:'completed',payloadState:'complete',input:{query:'secret context'},output:{matches:['secret result']}});
    expect(instance.sql`SELECT COUNT(*) AS count FROM agent_trace_payload_chunks`[0]!.count).toBe(0);
    log.mockRestore();
  });
});

test('deletion revokes diagnostic payloads and a late completion cannot recreate them', async () => {
  const {runtime,runId,conversationId,userId}=await seed('trace-deletion-race','running');
  await runInDurableObject(runtime,async instance=>{
    const manager=(instance as unknown as {traceManager:import('../src/agents/runtime/tool-call-trace').ToolCallTraceManager}).traceManager;
    let release!:()=>void;
    let entered!:()=>void;
    const started=new Promise<void>(resolve=>{entered=resolve;});
    const waiting=new Promise<void>(resolve=>{release=resolve;});
    const pending=manager.track(runId,{toolCallId:'late',name:'read_session_evidence',operation:'context',input:{private:'input'},execute:async()=>{entered();await waiting;return {private:'output'};}});
    await started;
    await manager.publishPending();
    const before=await env.DB.prepare('SELECT * FROM agent_tool_traces WHERE run_id=?').bind(runId).first<import('../src/agents/runtime/admin-tool-traces').AdminTraceRow>();
    await instance.deleteSessionAssets(conversationId,userId);
    release();
    await pending;
    expect(await readAdminToolTrace(env,runId,before!.trace_id)).toMatchObject({payloadState:'deleted',input:null});
    expect(await env.RESEARCH.get(before!.input_key!)).toBeNull();
    const objects=await env.RESEARCH.list({prefix:'agent-traces/'});
    expect(objects.objects.filter(object=>object.key.includes(runId))).toHaveLength(0);
  });
});

test('watchdog reconciliation exposes unmatched tool calls as interrupted', async () => {
  const {runtime,runId}=await seed('trace-watchdog-interruption','running');
  await runInDurableObject(runtime,async instance=>{
    const manager=(instance as unknown as {traceManager:import('../src/agents/runtime/tool-call-trace').ToolCallTraceManager}).traceManager;
    let entered!:()=>void,release!:()=>void;
    const started=new Promise<void>(resolve=>{entered=resolve;});
    const waiting=new Promise<void>(resolve=>{release=resolve;});
    const pending=manager.track(runId,{toolCallId:'interrupted',name:'search_context',operation:'context',input:{query:'saved data'},execute:async()=>{
      entered();await waiting;throw new Error('Aborted after run deadline.');
    }});
    // Attach the rejection handler before releasing the synthetic aborted call.
    const rejected=expect(pending).rejects.toThrow('Aborted after run deadline.');
    await started;
    await instance.reconcileRun(runId);
    await manager.publishPending();
    const row=await env.DB.prepare('SELECT trace_id,run_status FROM agent_tool_traces WHERE run_id=?').bind(runId).first<{trace_id:string;run_status:string}>();
    expect(row?.run_status).toBe('failed');
    expect(await readAdminToolTrace(env,runId,row!.trace_id)).toMatchObject({status:'interrupted',error:{code:'TOOL_INTERRUPTED'}});
    release();await rejected;
  });
});


test.each(['R2','D1'] as const)('slow %s uploads do not delay tool execution or the next call', async service => {
  const {runtime,runId}=await seed(`trace-background-${service}`,'running');
  await runInDurableObject(runtime,async instance=>{
    const manager=(instance as unknown as {traceManager:import('../src/agents/runtime/tool-call-trace').ToolCallTraceManager}).traceManager;
    let entered!:()=>void,release!:()=>void;
    const started=new Promise<void>(resolve=>{entered=resolve;});
    const waiting=new Promise<void>(resolve=>{release=resolve;});
    const put=env.RESEARCH.put.bind(env.RESEARCH);
    const prepare=env.DB.prepare.bind(env.DB);
    const storage=service==='R2' ? vi.spyOn(env.RESEARCH,'put').mockImplementation(async (...args)=>{
      entered();await waiting;return put(...args);
    }) : null;
    const db=service==='D1' ? vi.spyOn(env.DB,'prepare').mockImplementation(sql=>{
      const statement=prepare(sql);
      if (sql.startsWith('INSERT INTO agent_tool_traces')) {
        const bind=statement.bind.bind(statement);
        vi.spyOn(statement,'bind').mockImplementation((...values)=>{
          const bound=bind(...values);
          const run=bound.run.bind(bound);
          vi.spyOn(bound,'run').mockImplementation(async()=>{entered();await waiting;return run();});
          return bound;
        });
      }
      return statement;
    }) : null;
    try {
      let executed=false;
      const first=manager.track(runId,{toolCallId:'first',name:'context_read',operation:'context',input:{id:1},execute:async()=>{
        executed=true;return {full:'first output'};
      }});
      expect(executed).toBe(true);
      await started;
      expect(await first).toEqual({full:'first output'});
      expect(await manager.track(runId,{toolCallId:'second',name:'context_read',operation:'context',input:{id:2},execute:async()=>({full:'second output'})}))
        .toEqual({full:'second output'});
      expect(instance.sql`SELECT status FROM agent_call_traces`).toEqual([{status:'completed'},{status:'completed'}]);
    } finally {
      release();await manager.publishPending();storage?.mockRestore();db?.mockRestore();
    }
    const rows=await env.DB.prepare('SELECT * FROM agent_tool_traces WHERE run_id=? ORDER BY call_sequence').bind(runId).all<import('../src/agents/runtime/admin-tool-traces').AdminTraceRow>();
    expect(rows.results).toHaveLength(2);
    expect((await readAdminToolTrace(env,runId,rows.results[1]!.trace_id))?.output).toEqual({full:'second output'});
  });
});

test('a fresh trace manager recovers large immutable UTF-8 snapshots from the durable buffer', async()=>{
  const {runtime,runId,userId,conversationId}=await seed('trace-buffer-recovery','running');
  await runInDurableObject(runtime,async (instance,state)=>{
    const {ToolCallTraceManager}=await import('../src/agents/runtime/tool-call-trace');
    const manager=(instance as unknown as {traceManager:InstanceType<typeof ToolCallTraceManager>}).traceManager;
    const text='漢🙂'.repeat(400_000); // Larger than SQLite's 2 MB row limit.
    const input={text,nested:{original:true}};
    const output={text,tail:'last complete output'};
    const log=vi.spyOn(console,'error').mockImplementation(()=>{});
    const storage=vi.spyOn(env.RESEARCH,'put').mockRejectedValue(new Error('Temporary R2 outage'));
    try {
      const result=await manager.track(runId,{toolCallId:'recover',name:'context_read',operation:'context',input,execute:async()=>{
        input.nested.original=false;return output;
      }});
      expect(result).toBe(output);
      output.tail='mutated after return';
      await manager.publishPending();
      expect(instance.sql`SELECT COUNT(*) AS count FROM agent_trace_payload_chunks`[0]!.count).toBeGreaterThan(20);
      expect(instance.getSchedules().some(schedule=>schedule.callback==='retryTraceIndex')).toBe(true);
    } finally {storage.mockRestore();log.mockRestore();}
    const key=instance.sql<{input_key:string}>`SELECT input_key FROM agent_call_traces`[0]!.input_key;
    const prefix=key.slice(0,key.indexOf(runId));
    const recovered=new ToolCallTraceManager({sql:state.storage.sql,transaction:work=>state.storage.transactionSync(work),bucket:env.RESEARCH,prefix,
      queueCleanup:()=>{},cleanup:async()=>{},db:env.DB,metadata:()=>({userId,sessionId:conversationId,status:'running'})});
    await recovered.publishPending();
    const row=await env.DB.prepare('SELECT trace_id FROM agent_tool_traces WHERE run_id=?').bind(runId).first<{trace_id:string}>();
    const detail=await readAdminToolTrace(env,runId,row!.trace_id);
    expect(detail).toMatchObject({payloadState:'complete',input:{text,nested:{original:true}},output:{text,tail:'last complete output'}});
    expect(detail?.captureError).toBeUndefined();
    expect(instance.sql`SELECT COUNT(*) AS count FROM agent_trace_payload_chunks`[0]!.count).toBe(0);
  });
});

test('deletion removes buffered snapshots and cleans up an R2 upload finishing after revocation', async()=>{
  const {runtime,runId,conversationId,userId}=await seed('trace-upload-deletion','running');
  await runInDurableObject(runtime,async instance=>{
    const manager=(instance as unknown as {traceManager:import('../src/agents/runtime/tool-call-trace').ToolCallTraceManager}).traceManager;
    let entered!:()=>void,release!:()=>void;
    const started=new Promise<void>(resolve=>{entered=resolve;});
    const waiting=new Promise<void>(resolve=>{release=resolve;});
    const put=env.RESEARCH.put.bind(env.RESEARCH);
    const storage=vi.spyOn(env.RESEARCH,'put').mockImplementation(async(...args)=>{entered();await waiting;return put(...args);});
    try {
      await manager.track(runId,{toolCallId:'private',name:'context_read',operation:'context',input:{private:'input'},execute:async()=>({private:'output'})});
      await started;
      const deletion=instance.deleteSessionAssets(conversationId,userId);
      expect(instance.sql`SELECT COUNT(*) AS count FROM agent_trace_payload_chunks`[0]!.count).toBe(0);
      release();await deletion;
      await manager.publishPending();
      const row=await env.DB.prepare('SELECT trace_id FROM agent_tool_traces WHERE run_id=?').bind(runId).first<{trace_id:string}>();
      expect(await readAdminToolTrace(env,runId,row!.trace_id)).toMatchObject({payloadState:'deleted',input:null});
      const objects=await env.RESEARCH.list({prefix:'agent-traces/'});
      expect(objects.objects.filter(object=>object.key.includes(runId))).toHaveLength(0);
    } finally {release();await manager.publishPending();storage.mockRestore();}
  });
});


test('alarm retries rearm through an outage and drain more than one trace batch', async()=>{
  const {runtime,runId}=await seed('trace-alarm-outage','running');
  await runInDurableObject(runtime,async instance=>{
    const manager=(instance as unknown as {traceManager:import('../src/agents/runtime/tool-call-trace').ToolCallTraceManager}).traceManager;
    const log=vi.spyOn(console,'error').mockImplementation(()=>{});
    const storage=vi.spyOn(env.RESEARCH,'put').mockRejectedValue(new Error('R2 outage'));
    try {
      await Promise.all(Array.from({length:40},(_,i)=>manager.track(runId,{toolCallId:`batch-${i}`,name:'context_read',operation:'context',input:{i},execute:async()=>({complete:i})})));
      await manager.publishPending();
      const before=instance.getSchedules().filter(schedule=>schedule.callback==='retryTraceIndex');
      expect(before).toHaveLength(1);
      instance.sql`UPDATE cf_agents_schedules SET time=0 WHERE callback='retryTraceIndex'`;
      await instance.alarm();
      const after=instance.getSchedules().filter(schedule=>schedule.callback==='retryTraceIndex');
      expect(after).toHaveLength(1);
      expect(after[0]!.id).not.toBe(before[0]!.id);
      expect(after[0]!.time).toBeGreaterThan(Math.floor(Date.now()/1000));
      expect(instance.sql`SELECT COUNT(*) AS count FROM agent_trace_payload_chunks`[0]!.count).toBe(80);
    } finally {storage.mockRestore();log.mockRestore();}
    instance.sql`UPDATE cf_agents_schedules SET time=0 WHERE callback='retryTraceIndex'`;
    await instance.alarm();
    expect(instance.sql`SELECT COUNT(*) AS count FROM agent_trace_payload_chunks`[0]!.count).toBe(0);
    expect(instance.sql`SELECT COUNT(*) AS count FROM agent_call_traces WHERE index_pending=1`[0]!.count).toBe(0);
    const rows=await env.DB.prepare('SELECT * FROM agent_tool_traces WHERE run_id=? ORDER BY call_sequence').bind(runId).all<import('../src/agents/runtime/admin-tool-traces').AdminTraceRow>();
    expect(rows.results).toHaveLength(40);
    expect((await readAdminToolTrace(env,runId,rows.results[39]!.trace_id))?.output).toEqual({complete:39});
  });
});

test('evidence deletion fences an in-flight result before waiting for trace publication',async()=>{
  const {runtime,runId,conversationId,userId}=await seed('trace-delete-fence','running');
  await runInDurableObject(runtime,async instance=>{
    const writer=instance as unknown as {
      performEvidenceTool(runId:string,execution:EvidenceToolExecution):Promise<EvidencePacket>;
      traceManager:import('../src/agents/runtime/tool-call-trace').ToolCallTraceManager;
      sessionStore:import('../src/agents/runtime/session-evidence').SessionEvidenceStore;
    };
    let releaseTool!:()=>void,releasePublish!:()=>void;
    const toolGate=new Promise<void>(resolve=>{releaseTool=resolve;});
    const publishGate=new Promise<void>(resolve=>{releasePublish=resolve;});
    const publish=vi.spyOn(writer.traceManager,'publishPending').mockReturnValue(publishGate);
    const pending=writer.performEvidenceTool(runId,{toolCallId:'late-evidence',toolName:'get_video_transcript',operation:'transcript',semanticKey:'late',input:{},execute:async()=>{
      await toolGate;
      return {packetId:'deleted-packet',kind:'youtube_transcript',sources:[],excerpts:[],artifacts:[],warnings:[],usage:[]};
    }});
    const generation=writer.sessionStore.generation();
    const deletion=instance.deleteSessionAssets(conversationId,userId);
    try {
      expect(writer.sessionStore.generation()).toBe(generation+1);
      releaseTool();
      await expect(pending).rejects.toThrow('Evidence was deleted during execution');
      expect(instance.sql`SELECT * FROM agent_evidence_packets`).toHaveLength(0);
    } finally {releaseTool();releasePublish();await deletion;publish.mockRestore();}
  });
});

test('traced finalization and evidence replay return saved results after completion',async()=>{
  const {runtime,runId}=await seed('trace-terminal-replay','running');
  await runInDurableObject(runtime,async instance=>{
    const writer=instance as unknown as {
      finalizeRun(runId:string,id:string,input:FinalizeAnswerInput):Promise<AgentTurnResult>;
      traceToolCall: <T>(runId:string,call:import('../src/agents/runtime/tool-call-trace').TraceExecution<T>)=>Promise<T>;
      executeEvidenceTool(runId:string,execution:EvidenceToolExecution):Promise<EvidencePacket>;
    };
    const packet:EvidencePacket={packetId:'cached-packet',kind:'youtube_transcript',sources:[],excerpts:[],artifacts:[],warnings:[],usage:[]};
    instance.sql`UPDATE agent_tool_calls SET result_json=${JSON.stringify(packet)} WHERE run_id=${runId} AND tool_call_id='tool'`;
    instance.sql`INSERT INTO agent_routes VALUES (${runId},${JSON.stringify({route:'finalize',responseIntent:'clarification',reason:'Missing subject'})},0)`;
    const input:FinalizeAnswerInput={intent:'clarification',answer:'Which video?',confidence:'low',citations:[],artifacts:[],warnings:[]};
    const saved=await writer.finalizeRun(runId,'final',input);
    const replay=await writer.traceToolCall(runId,{toolCallId:'final-again',name:'finalize_answer',operation:'finalize',source:'model',input,
      execute:()=>writer.finalizeRun(runId,'final-again',input)});
    expect(replay).toEqual(saved);
    const execute=vi.fn(async()=>packet);
    expect(await writer.executeEvidenceTool(runId,{toolCallId:'tool',toolName:'get_video',operation:'video',semanticKey:'meaning',input:{},execute})).toEqual(packet);
    await expect(writer.executeEvidenceTool(runId,{toolCallId:'new',toolName:'get_video',operation:'video',semanticKey:'new',input:{},execute})).rejects.toThrow('no longer active');
    expect(execute).not.toHaveBeenCalled();
  });
});

test('failed trace batches rotate so later healthy payloads publish and recovery cancels the alarm',async()=>{
  const {runtime,runId}=await seed('trace-fair-retry','running');
  await runInDurableObject(runtime,async instance=>{
    const manager=(instance as unknown as {traceManager:import('../src/agents/runtime/tool-call-trace').ToolCallTraceManager}).traceManager;
    const put=env.RESEARCH.put.bind(env.RESEARCH);
    const log=vi.spyOn(console,'error').mockImplementation(()=>{});
    const storage=vi.spyOn(env.RESEARCH,'put').mockRejectedValue(new Error('Unavailable'));
    try {
      await Promise.all(Array.from({length:40},(_,i)=>manager.track(runId,{toolCallId:`fair-${i}`,name:'context_read',operation:'context',input:{i},execute:async()=>({i})})));
      await manager.publishPending();
      const rows=instance.sql<{trace_id:string;tool_call_id:string}>`SELECT trace_id,tool_call_id FROM agent_call_traces`;
      const poison=new Set(rows.filter(row=>Number(row.tool_call_id.slice(5))<32).map(row=>row.trace_id));
      storage.mockImplementation((...args)=>{
        if ([...poison].some(id=>String(args[0]).includes(id))) return Promise.reject(new Error('Permanent payload failure'));
        return put(...args);
      });
      for (let i=0;i<3;i++) await manager.publishPending();
      const pending=instance.sql<{trace_id:string}>`SELECT DISTINCT trace_id FROM agent_trace_payload_chunks`;
      expect(pending).toHaveLength(32);
      expect(pending.every(row=>poison.has(row.trace_id))).toBe(true);
      expect(instance.getSchedules().some(s=>s.callback==='retryTraceIndex')).toBe(true);
    } finally {storage.mockRestore();log.mockRestore();}
    await manager.publishPending();
    expect(manager.hasPending).toBe(false);
    expect(instance.getSchedules().filter(s=>s.callback==='retryTraceIndex')).toHaveLength(0);
    const summary=await env.DB.prepare('SELECT call_count,status FROM agent_trace_runs WHERE run_id=?').bind(runId).first();
    expect(summary).toMatchObject({call_count:40,status:'running'});
  });
});

test('export projections read each payload once and reject changes to the pinned revision',async()=>{
  const {runtime,runId}=await seed('trace-export-revision','running');
  await runInDurableObject(runtime,async instance=>{
    const manager=(instance as unknown as {traceManager:import('../src/agents/runtime/tool-call-trace').ToolCallTraceManager}).traceManager;
    await manager.track(runId,{toolCallId:'export',name:'context_read',operation:'context',input:{private:'input'},execute:async()=>({private:'output'})});
    await manager.publishPending();
    const row=(await env.DB.prepare('SELECT * FROM agent_tool_traces WHERE run_id=?').bind(runId).first<import('../src/agents/runtime/admin-tool-traces').AdminTraceRow>())!;
    const get=vi.spyOn(env.RESEARCH,'get');
    try {
      expect(await readAdminToolTrace(env,runId,row.trace_id,{snapshot:row,event:'tool/call'})).toMatchObject({input:{private:'input'},payloadState:'complete'});
      expect(await readAdminToolTrace(env,runId,row.trace_id,{snapshot:row,event:'tool/result'})).toMatchObject({output:{private:'output'},payloadState:'complete'});
      expect(get.mock.calls.map(call=>call[0])).toEqual([row.input_key,row.output_key]);
      await env.DB.prepare('UPDATE agent_tool_traces SET index_version=index_version+1 WHERE trace_id=?').bind(row.trace_id).run();
      const changed=await readAdminToolTrace(env,runId,row.trace_id,{snapshot:row,event:'tool/result'});
      expect(changed).toMatchObject({input:null,payloadState:'unavailable'});
      expect(changed?.output).toBeUndefined();
      await env.DB.prepare('UPDATE agent_tool_traces SET deleted=1,index_version=index_version+1 WHERE trace_id=?').bind(row.trace_id).run();
      expect(await readAdminToolTrace(env,runId,row.trace_id,{snapshot:row,event:'tool/result'})).toMatchObject({input:null,payloadState:'deleted'});
    } finally {get.mockRestore();}
  });
});

test('run summaries retry independently and settled history is skipped during recovery',async()=>{
  const {runtime,runId}=await seed('trace-summary-retry','running');
  await runInDurableObject(runtime,async instance=>{
    const manager=(instance as unknown as {traceManager:import('../src/agents/runtime/tool-call-trace').ToolCallTraceManager}).traceManager;
    const prepare=env.DB.prepare.bind(env.DB);
    const log=vi.spyOn(console,'error').mockImplementation(()=>{});
    const db=vi.spyOn(env.DB,'prepare').mockImplementation(sql=>{
      if (sql.startsWith('INSERT INTO agent_trace_runs')) throw new Error('Summary index unavailable');
      return prepare(sql);
    });
    try {
      await manager.track(runId,{toolCallId:'summary',name:'context_read',operation:'context',input:{},execute:async()=>({ok:true})});
      await manager.publishPending();
      expect(instance.sql`SELECT index_pending FROM agent_trace_run_index`).toEqual([{index_pending:1}]);
      expect(await prepare('SELECT trace_id FROM agent_tool_traces WHERE run_id=?').bind(runId).first()).not.toBeNull();
    } finally {db.mockRestore();log.mockRestore();}
    instance.sql`UPDATE agent_runs SET status='completed' WHERE id=${runId}`;
    manager.syncRun(runId);
    await manager.publishPending();
    expect(await env.DB.prepare('SELECT status,call_count FROM agent_trace_runs WHERE run_id=?').bind(runId).first()).toMatchObject({status:'completed',call_count:1});
    expect(manager.hasPending).toBe(false);
    const metadata=vi.spyOn(manager as unknown as {metadata:unknown},'metadata','get');
    try {await manager.publishPending();expect(metadata).not.toHaveBeenCalled();}
    finally {metadata.mockRestore();}
  });
});

test.each(['memory','other-version','same-version'] as const)('in-flight analysis handles %s deletion without a global invalidation',async deletion=>{
  const {runtime,runId,conversationId,userId}=await seed(`trace-scoped-delete-${deletion}`,'running');
  await runInDurableObject(runtime,async instance=>{
    const writer=instance as unknown as {
      sessionStore:import('../src/agents/runtime/session-evidence').SessionEvidenceStore;
      performEvidenceTool(runId:string,execution:EvidenceToolExecution):Promise<EvidencePacket>;
    };
    const store=writer.sessionStore;
    const asset=async(id:string)=>store.retrieve(`transcript:${id}:default`,'transcript',id,false,
      async()=>({value:{videoId:id,text:'Saved caption',segments:[]},cacheStatus:'miss'}),()=>({complete:true}));
    const kept=await asset('abcdefghijk'),other=await asset('lmnopqrstuv');
    let release!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;});
    const pending=writer.performEvidenceTool(runId,{toolCallId:'analysis',toolName:'analyze_video_transcript',operation:'transcript',semanticKey:'analysis',input:{},execute:async()=>{
      await gate;
      return {packetId:'analysis-result',kind:'youtube_transcript',assetVersions:kept.assetVersions,sources:[],excerpts:[],artifacts:[],warnings:[],usage:[]};
    }});
    const generation=store.clearGeneration();
    if (deletion==='memory') store.deleteMemory('unrelated-memory');
    else await instance.deleteSessionAssets(conversationId,userId,(deletion==='other-version' ? other : kept).assetVersions![0]);
    expect(store.clearGeneration()).toBe(generation);
    release();
    if (deletion==='same-version') await expect(pending).rejects.toThrow('Evidence was deleted during analysis');
    else expect(await pending).toMatchObject({assetVersions:kept.assetVersions});
  });
});

test('publication requested during alarm cancellation completes in the joined promise',async()=>{
  const {runtime,runId}=await seed('trace-publish-finally-race','running');
  await runInDurableObject(runtime,async instance=>{
    const manager=(instance as unknown as {traceManager:import('../src/agents/runtime/tool-call-trace').ToolCallTraceManager}).traceManager;
    const options=(manager as unknown as {options:{cancelRetry:()=>Promise<void>}}).options;
    const cancel=options.cancelRetry;
    let entered!:()=>void,release!:()=>void;
    const started=new Promise<void>(resolve=>{entered=resolve;});
    const waiting=new Promise<void>(resolve=>{release=resolve;});
    const cancellation=vi.spyOn(options,'cancelRetry').mockImplementationOnce(async()=>{entered();await waiting;await cancel();});
    try {
      await manager.track(runId,{toolCallId:'first',name:'context_read',operation:'context',input:{secret:'input'},execute:async()=>({secret:'output'})});
      await started;
      manager.revokePayloads();
      const deletionPublication=manager.publishPending();
      await manager.track(runId,{toolCallId:'second',name:'context_read',operation:'context',input:{new:true},execute:async()=>({new:true})});
      release();
      await deletionPublication;
      expect(manager.hasPending).toBe(false);
      const rows=await env.DB.prepare('SELECT tool_call_id,deleted,status FROM agent_tool_traces WHERE run_id=? ORDER BY call_sequence').bind(runId).all();
      expect(rows.results).toEqual([{tool_call_id:'first',deleted:1,status:'completed'},{tool_call_id:'second',deleted:0,status:'completed'}]);
      expect(instance.sql`SELECT * FROM agent_trace_publish_order`).toHaveLength(0);
      expect(instance.getSchedules().filter(s=>s.callback==='retryTraceIndex')).toHaveLength(0);
    } finally {release();await manager.publishPending();cancellation.mockRestore();}
  });
});


test('failed tool traces publish only matching current extraction diagnostics to R2', async () => {
  const {runtime,runId}=await seed('trace-container-diagnostics','running');
  await runInDurableObject(runtime, async instance => {
    const methods = instance as unknown as {
      traceManager: import('../src/agents/runtime/tool-call-trace').ToolCallTraceManager;
      recordExtractionDiagnostic(runId: string, event: import('../src/lib/extraction-diagnostics').StoredExtractionDiagnostic): void;
    };
    const { extractionFixture } = await import('./fixtures/extraction-diagnostic');
    const diagnostic = { ...extractionFixture, kind: 'frames' as const, toolCallId: 'failed-frames',
      outcome: 'failed' as const, events: [{ stage: 'job' as const, code: 'UNAVAILABLE' as const,
        failureReason: 'live_or_unconfirmed_broadcast' as const }] };
    methods.recordExtractionDiagnostic(runId, { ...diagnostic, recordedAt: 1 });
    const failure = new Error('Frame extraction failed.');
    await expect(methods.traceManager.track(runId, { toolCallId: 'failed-frames', name: 'get_video_frames',
      operation: 'frames', input: { videoId: 'abcdefghijk' }, execute: async () => {
        methods.recordExtractionDiagnostic(runId, { ...diagnostic, recordedAt: Date.now() });
        methods.recordExtractionDiagnostic(runId, { ...diagnostic, toolCallId: 'another-call', recordedAt: Date.now() });
        throw failure;
      } })).rejects.toBe(failure);
    await methods.traceManager.publishPending();
    const row = await env.DB.prepare('SELECT trace_id FROM agent_tool_traces WHERE run_id=? AND tool_call_id=?')
      .bind(runId, 'failed-frames').first<{trace_id:string}>();
    const detail = await readAdminToolTrace(env, runId, row!.trace_id);
    expect(detail?.error?.extractionDiagnostics).toHaveLength(1);
    expect(detail?.error?.extractionDiagnostics?.[0]).toMatchObject({ toolCallId: 'failed-frames', events: diagnostic.events });
    expect(detail?.payloadState).toBe('complete');
  });
});

test('a run stores the client time zone and older runs fall back to UTC', async () => {
  const { runtime, userId } = await seed('run-time-zone');
  await runInDurableObject(runtime, async (instance, state) => {
    const fiber = vi.spyOn(instance, 'startFiber').mockResolvedValue({
      fiberId: 'zone', name: 'agent-runtime-run', status: 'running', createdAt: Date.now(), accepted: true,
    });
    const zoned = await instance.startRun({ message: 'Videos from this year', conversationId: crypto.randomUUID(), timeZone: 'Asia/Kolkata' },
      { userId, creditsRemaining: 1000 });
    const plain = await instance.startRun({ message: 'Videos from today', conversationId: crypto.randomUUID() },
      { userId, creditsRemaining: 1000 });
    if ('rejected' in zoned || 'rejected' in plain) throw new Error('run rejected');
    const zone = (runId: string) => state.storage.sql.exec('SELECT time_zone FROM agent_runs WHERE id = ?', runId).toArray()[0];
    expect(zone(zoned.runId)).toEqual({ time_zone: 'Asia/Kolkata' });
    expect(zone(plain.runId)).toEqual({ time_zone: null });
    fiber.mockRestore();
  });
});


test('visual latency survives successful and failed trace publication', async () => {
  const {runtime,runId}=await seed('trace-visual-latency','running');
  await runInDurableObject(runtime, async instance => {
    const {diagnoseVisualTool, visualSpan, countVisualWork}=await import('../src/lib/visual-diagnostics');
    const manager=(instance as unknown as {traceManager:import('../src/agents/runtime/tool-call-trace').ToolCallTraceManager}).traceManager;
    for (const fail of [false,true]) {
      const toolCallId=fail?'visual-failure':'visual-success';
      const failure=new Error('extraction failed');
      const result=manager.track(runId,{toolCallId,name:'get_video_frames',operation:'frames',input:{},
        execute:()=>diagnoseVisualTool('frames',()=>visualSpan('retrieval',async()=>{
          countVisualWork('requestedImages',2);
          if(fail) throw failure;
          return {artifacts:[{data:{}}]};
        }))});
      if(fail) await expect(result).rejects.toBe(failure); else await result;
      await manager.publishPending();
      const row=await env.DB.prepare('SELECT trace_id FROM agent_tool_traces WHERE run_id=? AND tool_call_id=?')
        .bind(runId,toolCallId).first<{trace_id:string}>();
      const detail=await readAdminToolTrace(env,runId,row!.trace_id);
      const diagnostics=fail?detail?.error?.visualDiagnostics
        :(detail?.output as {artifacts:{data:{visualDiagnostics:unknown}}[]}).artifacts[0]!.data.visualDiagnostics;
      expect(diagnostics).toMatchObject({version:1,scope:'tool',kind:'frames',outcome:fail?'error':'success',counters:{requestedImages:2}});
      expect(detail?.payloadState).toBe('complete');
    }
  });
});

test('concurrent visual traces retain their own diagnostics after a shared abort', async () => {
  const {runtime,runId}=await seed('trace-shared-visual-abort','running');
  await runInDurableObject(runtime, async instance => {
    const {diagnoseVisualTool,countVisualWork}=await import('../src/lib/visual-diagnostics');
    const {withRunDeadline}=await import('../src/agents/runtime/deadline');
    const manager=(instance as unknown as {traceManager:import('../src/agents/runtime/tool-call-trace').ToolCallTraceManager}).traceManager;
    const controller=new AbortController();
    const failure=new Error('shared run cancellation');
    let started=0,ready!:()=>void;
    const bothStarted=new Promise<void>(resolve=>{ready=resolve;});
    const calls=[1,2].map(count=>manager.track(runId,{
      toolCallId:`shared-abort-${count}`,name:'get_video_storyboard',operation:'storyboard',input:{},
      execute:()=>diagnoseVisualTool('storyboard',async()=>{
        countVisualWork('requestedImages',count);
        return withRunDeadline(Date.now()+60_000,controller.signal,async signal=>{
          if(++started===2) ready();
          return new Promise<{artifacts:[]}>( (_,reject)=>{
            signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
          });
        });
      },{runId,toolCallId:`shared-abort-${count}`}),
    }));
    const settled=Promise.allSettled(calls);
    await bothStarted;
    controller.abort(failure);
    for(const result of await settled) {
      expect(result.status).toBe('rejected');
      if(result.status==='rejected') expect(result.reason).toBe(failure);
    }
    await manager.publishPending();
    const operationIds=new Set<string>();
    for(const count of [1,2]) {
      const row=await env.DB.prepare('SELECT trace_id FROM agent_tool_traces WHERE run_id=? AND tool_call_id=?')
        .bind(runId,`shared-abort-${count}`).first<{trace_id:string}>();
      const detail=await readAdminToolTrace(env,runId,row!.trace_id);
      expect(detail?.payloadState).toBe('complete');
      expect(detail?.error?.visualDiagnostics).toMatchObject({scope:'tool',kind:'storyboard',outcome:'error',
        counters:{requestedImages:count}});
      operationIds.add(detail!.error!.visualDiagnostics!.operationId);
    }
    expect(operationIds.size).toBe(2);
  });
});
