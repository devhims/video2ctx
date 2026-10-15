import { userAccountInstanceName } from '../agents/runtime/identity';

export async function billingAccount(env: Env, userId: string) {
  return env.USER_ACCOUNT.getByName(await userAccountInstanceName(userId));
}

export class UncertainBillingWriteError extends Error {
  constructor(readonly operation: 'customer-create' | 'checkout-create', cause: unknown) {
    super('The billing write outcome requires reconciliation.', { cause });
    this.name = 'UncertainBillingWriteError';
  }
}

/** Persist the write before sending it; only a confirmed outcome releases it. */
export async function billingWrite<T>(
  account: Awaited<ReturnType<typeof billingAccount>>, claim: string,
  operation: 'customer-create' | 'checkout-create', write: () => Promise<T>,
): Promise<T> {
  await account.beginBillingCheckoutWrite(claim, operation);
  let result: T;
  try {
    result = await write();
  } catch (cause) {
    const status = typeof cause === 'object' && cause !== null && 'statusCode' in cause ? cause.statusCode : undefined;
    if (typeof status === 'number' && status >= 400 && status < 500 && status !== 408) {
      await account.finishBillingCheckoutWrite(claim);
      throw cause;
    }
    await account.markBillingCheckoutUncertain(claim);
    throw new UncertainBillingWriteError(operation, cause);
  }
  await account.finishBillingCheckoutWrite(claim);
  return result;
}
