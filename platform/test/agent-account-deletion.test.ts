import { deleteAgentAccountData } from '../src/agents/runtime/account-deletion';

const conversationId = 'a08cff6c-326e-47f7-b771-59ff58c48846';
function harness() {
  const account = { beginDeletion: vi.fn().mockResolvedValue([conversationId]), finishDeletion: vi.fn() };
  const runtime = { deleteAccountData: vi.fn() };
  const env = { USER_ACCOUNT: { getByName: () => account }, AGENT_RUNTIME: { getByName: () => runtime } } as unknown as Env;
  return { account, runtime, env };
}

test('clears the registry only after every conversation has been deleted', async () => {
  const { account, runtime, env } = harness();
  await deleteAgentAccountData(env, 'user');
  expect(runtime.deleteAccountData).toHaveBeenCalledOnce();
  expect(account.finishDeletion).toHaveBeenCalledOnce();
  expect(runtime.deleteAccountData.mock.invocationCallOrder[0]).toBeLessThan(account.finishDeletion.mock.invocationCallOrder[0]!);
});

test('retains the deletion registry when conversation cleanup fails, and supports retry', async () => {
  const { account, runtime, env } = harness();
  runtime.deleteAccountData.mockRejectedValueOnce(new Error('runtime unavailable'));
  await expect(deleteAgentAccountData(env, 'user')).rejects.toThrow('runtime unavailable');
  expect(account.finishDeletion).not.toHaveBeenCalled();
  await deleteAgentAccountData(env, 'user');
  expect(account.finishDeletion).toHaveBeenCalledOnce();
});

test('cleans four conversations concurrently and drains a failed batch before allowing retry', async () => {
  const { account, runtime, env } = harness();
  account.beginDeletion.mockResolvedValue(Array.from({ length: 5 }, (_, i) => `${conversationId}-${i}`));
  const pending: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
  runtime.deleteAccountData.mockImplementation(() => new Promise<void>((resolve, reject) => pending.push({ resolve, reject })));
  let settled = false;
  const deletion = deleteAgentAccountData(env, 'user').finally(() => { settled = true; });
  const rejected = expect(deletion).rejects.toThrow('cleanup failed');
  await vi.waitFor(() => expect(pending).toHaveLength(4));
  pending[0]!.reject(new Error('cleanup failed'));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(settled).toBe(false);
  expect(account.finishDeletion).not.toHaveBeenCalled();
  for (const task of pending.slice(1)) task.resolve();
  await rejected;
  expect(runtime.deleteAccountData).toHaveBeenCalledTimes(4);
  expect(account.finishDeletion).not.toHaveBeenCalled();
  runtime.deleteAccountData.mockResolvedValue(undefined);
  await deleteAgentAccountData(env, 'user');
  expect(runtime.deleteAccountData).toHaveBeenCalledTimes(9);
  expect(account.finishDeletion).toHaveBeenCalledOnce();
});
