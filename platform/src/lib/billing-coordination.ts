import { userAccountInstanceName } from '../agents/runtime/identity';

export async function billingAccount(env: Env, userId: string) {
  return env.USER_ACCOUNT.getByName(await userAccountInstanceName(userId));
}
