import { handleQueue } from '../src/queues';

function task(error?: Error) {
  const ack = vi.fn(), retry = vi.fn(), recordProcessed = vi.fn();
  const remove = error ? vi.fn().mockRejectedValue(error) : vi.fn().mockResolvedValue(undefined);
  const env = {
    DB: { prepare: (sql: string) => ({ bind: () => sql.startsWith('SELECT') ? { first: async () => null } : { run: recordProcessed } }) },
    AI_SEARCH: { delete: remove },
  } as unknown as Env;
  const batch = { queue: 'video2ctx-tasks', messages: [{ body: { type: 'delete-user-search', idempotencyKey: 'delete-search:owner', payload: { instanceId: 'user-owner' } }, attempts: 1, ack, retry }] } as unknown as MessageBatch<unknown>;
  return { env, batch, ack, retry, recordProcessed, remove };
}

test('failed private search deletion remains retryable instead of being acknowledged', async () => {
  const h = task(new Error('provider unavailable'));
  await handleQueue(h.batch, h.env);
  expect(h.retry).toHaveBeenCalledOnce();
  expect(h.ack).not.toHaveBeenCalled();
  expect(h.recordProcessed).not.toHaveBeenCalled();
});

test.each([undefined, new Error('ai_search_not_found'), Object.assign(new Error('missing'), { status: 404 })])('completed or already-absent private search deletion is acknowledged: %s', async error => {
  const h = task(error);
  await handleQueue(h.batch, h.env);
  expect(h.ack).toHaveBeenCalledOnce();
  expect(h.retry).not.toHaveBeenCalled();
  expect(h.recordProcessed).toHaveBeenCalledOnce();
});
