import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, test, vi } from 'vitest';
import { AgentAdmissionQueue, type QueuedRunIdentity } from '../src/agents/runtime/admission-queue';
import type { AgentRequest, AgentAdmission } from '../src/agents/contracts';
import { removeIdempotencyColumn } from '../src/agents/runtime/remove-idempotency-column';

const request = { conversationId: 'a08cff6c-326e-47f7-b771-59ff58c48846', message: 'Research durable admissions' };
const admission = { userId: 'queue-test-user', creditsRemaining: 500 };
const accepted = (_request: AgentRequest, _admission: AgentAdmission, identity: QueuedRunIdentity) => ({
  ...identity, conversationId: request.conversationId, conversationTurn: 1, modelStepCount: 0, toolCallCount: 0, status: 'pending' as const,
});

describe('durable first-turn admission', () => {
  test('migrates a pending receipt and delivers its original agent message ID', async () => {
    const account = env.USER_ACCOUNT.getByName(crypto.randomUUID());
    await runInDurableObject(account, async (instance, state) => {
      const startRun = vi.fn(accepted);
      const queue = new AgentAdmissionQueue(state, { AGENT_RUNTIME: { getByName: () => ({ startRun }) } } as unknown as Env,
        { assertActive() {}, register: id => instance.registerConversation(id), record: input => instance.recordSession(input) });
      const first = await queue.enqueue(request, admission);
      state.storage.sql.exec(`UPDATE agent_admissions SET payload = json_remove(
        json_set(payload, '$.receipt.assistantMessageId', json_extract(payload, '$.receipt.agentMessageId')),
        '$.receipt.agentMessageId')`);
      queue.initialize();
      queue.initialize();
      expect(queue.pending(request.conversationId)?.run).toEqual(first.receipt);
      expect(queue.pending(request.conversationId)?.run).not.toHaveProperty('assistantMessageId');
      await queue.alarm();
      expect(startRun.mock.calls[0]?.[2]).toMatchObject({ agentMessageId: first.receipt?.agentMessageId });
      expect(startRun.mock.calls[0]?.[2]).not.toHaveProperty('assistantMessageId');
      expect(queue.pending(request.conversationId)).toBeNull();
      await state.storage.deleteAlarm();
    });
  });

  test('returns stable IDs and restores pending state without contacting a cold runtime', async () => {
    const account = env.USER_ACCOUNT.getByName(crypto.randomUUID());
    await runInDurableObject(account, async (instance, state) => {
      const startRun = vi.fn(accepted);
      const bindings = { AGENT_RUNTIME: { getByName: () => ({ startRun }) } } as unknown as Env;
      const hooks = { assertActive() {}, register: (id: string) => instance.registerConversation(id), record: (input: Parameters<typeof instance.recordSession>[0]) => instance.recordSession(input) };
      const queue = new AgentAdmissionQueue(state, bindings, hooks);
      const first = await queue.enqueue(request, admission);
      const retry = await queue.enqueue({ ...request, message: 'Different retry text must not replace the original' }, admission);
      expect(retry).toEqual({ legacy: true });
      expect(first.receipt?.request?.message).toBe(request.message);
      expect(startRun).not.toHaveBeenCalled();
      expect(await state.storage.getAlarm()).not.toBeNull();
      const restored = new AgentAdmissionQueue(state, bindings, hooks);
      expect(restored.pending(request.conversationId)?.run).toEqual(first.receipt);
      expect(instance.getSession(request.conversationId)?.runCount).toBe(1);
      await restored.alarm();
      expect(startRun).toHaveBeenCalledTimes(1);
      expect(startRun.mock.calls[0]?.[2]).toMatchObject({ runId: first.receipt?.runId, agentMessageId: first.receipt?.agentMessageId });
      expect(restored.pending(request.conversationId)).toBeNull();
      expect(await restored.enqueue(request, admission)).toEqual({ legacy: true });
      await state.storage.deleteAlarm();
    });
  });

  test('retries an ambiguous failure with the original identity and survives deletion', async () => {
    const account = env.USER_ACCOUNT.getByName(crypto.randomUUID());
    await runInDurableObject(account, async (instance, state) => {
      const startRun = vi.fn(accepted).mockImplementationOnce(() => { throw new Error('Reply lost after acceptance'); });
      const queue = new AgentAdmissionQueue(state, { AGENT_RUNTIME: { getByName: () => ({ startRun }) } } as unknown as Env,
        { assertActive() { if (state.storage.sql.exec('SELECT * FROM account_deletion').toArray().length) throw new Error('deleted'); }, register: id => instance.registerConversation(id), record: input => instance.recordSession(input) });
      const first = await queue.enqueue(request, admission);
      await queue.alarm();
      expect(queue.pending(request.conversationId)?.run.status).toBe('pending');
      state.storage.sql.exec('UPDATE agent_admissions SET next_attempt_at = 0');
      await queue.alarm();
      expect(startRun).toHaveBeenCalledTimes(2);
      expect(startRun.mock.calls[0]?.[2]).toEqual(startRun.mock.calls[1]?.[2]);
      expect(startRun.mock.calls[0]?.[1]).toEqual(admission);
      expect(instance.beginDeletion()).toContain(request.conversationId);
      instance.finishDeletion();
      expect(state.storage.sql.exec('SELECT * FROM agent_admissions').toArray()).toEqual([]);
      await expect(queue.enqueue(request, admission)).rejects.toThrow('deleted');
      expect(first.receipt).toBeDefined();
      await state.storage.deleteAlarm();
    });
  });

  test('does not restore deleted admission data after an in-flight startup reply', async () => {
    const account = env.USER_ACCOUNT.getByName(crypto.randomUUID());
    await runInDurableObject(account, async (instance, state) => {
      let resolveStarted!: () => void;
      const started = new Promise<void>(resolve => { resolveStarted = resolve; });
      let finish!: () => void;
      const reply = new Promise<void>(resolve => { finish = resolve; });
      let deleted = false;
      const startRun = vi.fn(async (req: AgentRequest, owner: AgentAdmission, identity: QueuedRunIdentity) => {
        resolveStarted(); await reply; return accepted(req, owner, identity);
      });
      const queue = new AgentAdmissionQueue(state, { AGENT_RUNTIME: { getByName: () => ({ startRun }) } } as unknown as Env,
        { assertActive() { if (deleted) throw new Error('deleted'); }, register: id => instance.registerConversation(id), record: input => instance.recordSession(input) });
      await queue.enqueue(request, admission);
      const delivery = queue.alarm();
      await started;
      expect(instance.beginDeletion()).toContain(request.conversationId);
      deleted = true;
      instance.finishDeletion();
      finish();
      await delivery;
      expect(state.storage.sql.exec('SELECT * FROM agent_admissions').toArray()).toEqual([]);
      await state.storage.deleteAlarm();
    });
  });

  test('rolls back admission if the session catalog cannot be recorded', async () => {
    const account = env.USER_ACCOUNT.getByName(crypto.randomUUID());
    await runInDurableObject(account, async (instance, state) => {
      const queue = new AgentAdmissionQueue(state, env, { assertActive() {}, register: id => instance.registerConversation(id), record() { throw new Error('catalog failed'); } });
      await expect(queue.enqueue(request, admission)).rejects.toThrow('catalog failed');
      expect(queue.pending(request.conversationId)).toBeNull();
      expect(instance.beginDeletion()).toEqual([]);
      await state.storage.deleteAlarm();
    });
  });
});

test.each([
  ['agent_runs', 'TEXT NOT NULL UNIQUE'], ['agent_runs', 'TEXT UNIQUE'],
  ['agent_admissions', 'TEXT NOT NULL'], ['agent_admissions', 'TEXT'],
] as const)('migrates legacy %s (%s) without losing rows or indexes', async (table, columnType) => {
  const account = env.USER_ACCOUNT.getByName(crypto.randomUUID());
  await runInDurableObject(account, async (_instance, state) => {
    state.storage.sql.exec(`DROP TABLE IF EXISTS ${table}`);
    state.storage.sql.exec(`CREATE TABLE ${table} (id TEXT PRIMARY KEY, idempotency_key ${columnType}, extra TEXT)`);
    state.storage.sql.exec(`CREATE INDEX migration_extra ON ${table}(extra)`);
    state.storage.sql.exec(`INSERT INTO ${table} VALUES ('old-run', 'legacy-key', 'keep this')`);
    removeIdempotencyColumn(state.storage, table);
    removeIdempotencyColumn(state.storage, table);
    expect(state.storage.sql.exec(`SELECT * FROM ${table}`).toArray()).toEqual([
      { id: 'old-run', extra: 'keep this' },
    ]);
    expect(state.storage.sql.exec(`PRAGMA index_list(${table})`).toArray())
      .toEqual(expect.arrayContaining([expect.objectContaining({ name: 'migration_extra' })]));
    state.storage.sql.exec(`INSERT INTO ${table} VALUES ('new-run-1', 'new'), ('new-run-2', 'new')`);
    expect(state.storage.sql.exec(`PRAGMA table_info(${table})`).toArray()).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: 'idempotency_key' })]));
    expect(state.storage.sql.exec(`SELECT COUNT(*) AS count FROM ${table}`).one().count).toBe(3);
  });
});
