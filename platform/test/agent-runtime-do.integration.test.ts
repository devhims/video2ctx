import { env, runInDurableObject } from 'cloudflare:test';
import { expect, test } from 'vitest';
import { reserveAgentCredits, settleAgentCredits } from '../src/agents/runtime/billing';
import { creditBalance } from '../src/lib/entitlements';

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
      credits_remaining_at_admission,created_at,updated_at)
      VALUES (${runId},${runId},${userId},${conversationId},${crypto.randomUUID()},${crypto.randomUUID()},
      1,'Private prompt',${status},'executing',1000,0,0)`;
    instance.sql`INSERT INTO agent_tool_calls (run_id,tool_call_id,semantic_key,tool_name,operation,status,credits,created_at,updated_at)
      VALUES (${runId},'tool','meaning','get_video','video','completed',1,0,0)`;
  });
  return { runtime, userId, runId, conversationId };
}

test('terminal run polling settles persisted evidence exactly once', async () => {
  const { runtime, userId, runId } = await seed('agent-settle-runtime');
  expect(await runtime.getRun(runId)).toMatchObject({ status: 'failed' });
  expect(await creditBalance(env, userId)).toBe(999);
  await runtime.getRun(runId);
  await runtime.reconcileRun(runId);
  expect(await creditBalance(env, userId)).toBe(999);
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

