import { agentInstanceName, userAccountInstanceName } from './identity';

export async function deleteAgentAccountData(env: Env, userId: string): Promise<void> {
  const account = env.USER_ACCOUNT.getByName(await userAccountInstanceName(userId));
  // The catalog retains its registry on any error so a retry can finish cleanup.
  const conversations = await account.beginDeletion();
  for (const conversationId of conversations) {
    const runtime = env.AGENT_RUNTIME.getByName(await agentInstanceName(userId, conversationId));
    await runtime.deleteAccountData();
  }
  await account.finishDeletion();
}
