/** Load auth plugins on first use; never share request-bound auth instances. */
export async function createRequestAuth(
  env: Env,
  executionCtx: { waitUntil(promise: Promise<unknown>): void },
  adminUserIds: string[] = [],
) {
  const { createAuth } = await import('./auth');
  return createAuth(env, executionCtx, adminUserIds);
}
