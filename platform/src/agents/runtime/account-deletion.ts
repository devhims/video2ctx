import { agentInstanceName, userAccountInstanceName } from './identity';
import { mapInBatches } from '../../lib/map-in-batches';

export async function deleteAgentAccountData(env: Env, userId: string): Promise<void> {
  const account = env.USER_ACCOUNT.getByName(await userAccountInstanceName(userId));
  // The catalog retains its registry on any error so a retry can finish cleanup.
  const conversations = await account.beginDeletion();
  // Independent conversations can drain together. Settle every started RPC before
  // returning an error, so the caller never releases its fence during cleanup.
  await mapInBatches(conversations, async conversationId => {
    const runtime = env.AGENT_RUNTIME.getByName(await agentInstanceName(userId, conversationId));
    await runtime.deleteAccountData();
  });
  await account.finishDeletion();
}
