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
    instance.sql`INSERT INTO agent_runs (id,idempotency_key,user_id,conversation_id,
      user_message_id,assistant_message_id,turn_ordinal,message,status,phase,
      credits_remaining_at_admission,created_at,updated_at,research_deadline_at)
      VALUES (${runId},${runId},${userId},${conversationId},${crypto.randomUUID()},${crypto.randomUUID()},
      1,'Private prompt',${status},'executing',1000,0,0,0)`;
    instance.sql`INSERT INTO agent_tool_calls (run_id,tool_call_id,semantic_key,tool_name,operation,status,credits,created_at,updated_at)
      VALUES (${runId},'tool','meaning','get_video','video','completed',1,0,0)`;
  });
  return { runtime, userId, runId, conversationId };
}

test('restores provider metadata for follow-ups and validates historical citations without another evidence charge', async () => {
  const { runtime, userId, runId, conversationId } = await seed('agent-metadata-memory', 'completed');
  await runInDurableObject(runtime, async instance => {
    const parent = instance.sql`SELECT * FROM agent_runs WHERE id = ${runId}`[0]!;
    const saved = JSON.stringify({ runId, conversationId, userMessageId: parent.user_message_id,
      assistantMessageId: parent.assistant_message_id, intent: 'inspect_video', answer: 'A summary.',
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
      { userId, idempotencyKey: 'metadata-followup', creditsRemaining: 999 });
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
        finalization_deadline_at: phase === 'finalizing' ? updatedAt + 40_000 : null });
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
      assistantMessageId: crypto.randomUUID(), intent: 'clarification', answer: 'Which topic?',
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
  await runtime.deleteAccountData();
  expect(await runtime.getRun(runId)).toBeNull();
  expect(await runtime.getConversation(conversationId, userId)).toBeNull();
  expect(await creditBalance(env, userId)).toBe(999);
  await runInDurableObject(runtime, async instance => {
  await expect(instance.startRun({ message: 'A delayed request', conversationId }, {
    userId, idempotencyKey: 'delayed-request', creditsRemaining: 999,
  })).rejects.toThrow('deletion');
  });
  await runtime.deleteAccountData();
  await runInDurableObject(runtime, async (_instance, state) => {
    for (const table of ['agent_runs', 'agent_tool_calls', 'agent_evidence_packets', 'agent_model_usage', 'agent_events', 'cf_agents_fibers']) {
      expect(state.storage.sql.exec(`SELECT COUNT(*) AS count FROM ${table}`).toArray()[0]).toMatchObject({ count: 0 });
    }
  });
});


test('queued admissions retain their IDs and do not expire before classification starts', async () => {
  const { runtime, userId } = await seed('queued-expired-admission');
  const request = { conversationId: crypto.randomUUID(), message: 'A delayed request' };
  const identity = { runId: crypto.randomUUID(), userMessageId: crypto.randomUUID(), assistantMessageId: crypto.randomUUID(), admittedAt: Date.now() - 81_000 };
  await runInDurableObject(runtime, async instance => {
    const fiber = vi.spyOn(instance, 'startFiber').mockResolvedValue({
      fiberId: identity.runId, name: 'agent-runtime-run', status: 'running', createdAt: Date.now(), accepted: true,
    });
    const receipt = await instance.startRun(request, { userId, idempotencyKey: 'expired-queued-request', creditsRemaining: 1000 }, identity);
    expect(receipt).toMatchObject({ request: { message: request.message }, runId: identity.runId, userMessageId: identity.userMessageId, assistantMessageId: identity.assistantMessageId, status: 'pending' });
    expect(fiber).toHaveBeenCalledOnce();
    fiber.mockRestore();
  });
});

test('an interrupted pending admission retries startup without inserting a duplicate run', async () => {
  const { runtime, userId } = await seed('queued-interrupted-admission');
  const request = { conversationId: crypto.randomUUID(), message: 'An interrupted request' };
  const identity = { runId: crypto.randomUUID(), userMessageId: crypto.randomUUID(), assistantMessageId: crypto.randomUUID(), admittedAt: Date.now() };
  await runInDurableObject(runtime, async instance => {
    const fiber = vi.spyOn(instance, 'startFiber').mockRejectedValue(new Error('startup interrupted'));
    const admission = { userId, idempotencyKey: 'interrupted-queued-request', creditsRemaining: 1000 };
    await expect(instance.startRun(request, admission, identity)).rejects.toThrow('startup interrupted');
    await expect(instance.startRun(request, admission, identity)).rejects.toThrow('startup interrupted');
    expect(fiber).toHaveBeenCalledTimes(2);
    expect(instance.sql`SELECT id FROM agent_runs WHERE conversation_id = ${request.conversationId}`).toEqual([{ id: identity.runId }]);
    fiber.mockRestore();
  });
});

test('saves a ready answer after the model deadline and settles it idempotently', async () => {
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
    const admission = { userId, idempotencyKey: 'retry-context', creditsRemaining: 999 };
    const receipt = await instance.startRun({ message: 'try again', conversationId }, admission);
    expect(receipt).not.toHaveProperty('rejected');
    if ('rejected' in receipt) return;
    expect(receipt.request).toEqual({ message: 'try again' });
    expect(instance.sql`SELECT message, execution_message, parent_message_id FROM agent_runs WHERE id = ${receipt.runId}`[0])
      .toEqual({ message: 'try again', execution_message: 'Private prompt', parent_message_id: null });
    instance.sql`UPDATE agent_runs SET status = 'failed' WHERE id = ${receipt.runId}`;
    const second = await instance.startRun({ message: 'Please try again.', conversationId }, { ...admission, idempotencyKey: 'retry-context-2' });
    if ('rejected' in second) throw Error(second.message);
    expect(instance.sql`SELECT execution_message FROM agent_runs WHERE id = ${second.runId}`[0])
      .toEqual({ execution_message: 'Private prompt' });
    const repeated = await instance.startRun({ message: 'try again', conversationId }, admission);
    if ('rejected' in repeated) throw Error(repeated.message);
    expect(repeated.runId).toBe(receipt.runId);
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
        { userId, idempotencyKey: crypto.randomUUID(), creditsRemaining: 999 });
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
      assistantMessageId: parentId, intent: 'clarification', answer: 'Which comparison?',
      confidence: 'low', citations: [], artifacts: [], warnings: [], billing: { creditsCharged: 0, creditsRemaining: 999 } });
    instance.sql`INSERT INTO agent_runs (id,idempotency_key,user_id,conversation_id,user_message_id,assistant_message_id,
      turn_ordinal,message,status,phase,result_json,credits_remaining_at_admission,created_at,updated_at)
      VALUES ('parent','parent',${userId},${conversationId},${crypto.randomUUID()},${parentId},0,'Earlier request','completed','completed',${result},999,0,0)`;
    instance.sql`UPDATE agent_runs SET message = 'Summarize https://youtu.be/abcdefghijk', parent_message_id = ${parentId} WHERE id = ${runId}`;
    const legacyId = crypto.randomUUID();
    instance.sql`INSERT INTO agent_runs (id,idempotency_key,user_id,conversation_id,parent_message_id,user_message_id,assistant_message_id,
      turn_ordinal,message,status,phase,credits_remaining_at_admission,created_at,updated_at)
      VALUES (${legacyId},${legacyId},${userId},${conversationId},${parentId},${crypto.randomUUID()},${crypto.randomUUID()},2,'try again','failed','failed',999,1,1)`;
    const fiber = vi.spyOn(instance, 'startFiber').mockResolvedValue({
      fiberId: 'legacy-retry', name: 'agent-runtime-run', status: 'running', createdAt: Date.now(), accepted: true,
    });
    const receipt = await instance.startRun({ message: 'retry', conversationId },
      { userId, idempotencyKey: 'legacy-retry', creditsRemaining: 999 });
    if ('rejected' in receipt) throw Error(receipt.message);
    const row = instance.sql`SELECT * FROM agent_runs WHERE id = ${receipt.runId}`[0]!;
    expect(row).toMatchObject({ execution_message: 'Summarize https://youtu.be/abcdefghijk', parent_message_id: parentId });
    const saved = JSON.stringify({ ...JSON.parse(result), runId: receipt.runId, userMessageId: receipt.userMessageId,
      assistantMessageId: receipt.assistantMessageId, answer: 'A summary.' });
    instance.sql`UPDATE agent_runs SET status = 'completed', result_json = ${saved} WHERE id = ${receipt.runId}`;
    const memory = instance as unknown as { readConversationHistory(row: unknown): import('../src/agents/runtime/conversation-memory').ConversationTurn[] };
    expect(memory.readConversationHistory({ ...row, parent_message_id: receipt.assistantMessageId }).at(-1))
      .toMatchObject({ user: 'Summarize https://youtu.be/abcdefghijk', assistant: 'A summary.', resourceIds: ['abcdefghijk'] });
    fiber.mockRestore();
  });
});
