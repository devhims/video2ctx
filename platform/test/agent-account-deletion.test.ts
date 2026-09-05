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
