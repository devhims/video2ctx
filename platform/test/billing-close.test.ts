const deleteExternal = vi.hoisted(() => vi.fn());
const getStateExternal = vi.hoisted(() => vi.fn());
vi.mock('../src/lib/polar-client', () => ({ polarClient: () => ({ customers: { deleteExternal, getStateExternal } }) }));

import { closeBillingAccount, requireNoRenewingSubscription } from '../src/lib/billing';

const polarError = (statusCode: number) => Object.assign(new Error(`Status ${statusCode}`), { statusCode });

function billingEnv(token: string | undefined, billingRow: boolean): Env {
  return {
    ...(token === undefined ? {} : { POLAR_ACCESS_TOKEN: token }),
    DB: { prepare: () => ({ bind: () => ({ first: async () => (billingRow ? { 1: 1 } : null) }) }) },
  } as unknown as Env;
}

describe('closing the billing account on account deletion', () => {
  beforeEach(() => { deleteExternal.mockReset(); });

  test('skips Polar for a never-billed user when billing is not configured', async () => {
    await expect(closeBillingAccount(billingEnv('', false), 'user-1')).resolves.toBeUndefined();
    await expect(closeBillingAccount(billingEnv(undefined, false), 'user-1')).resolves.toBeUndefined();
    expect(deleteExternal).not.toHaveBeenCalled();
  });

  test('refuses to continue for a known billing customer when the token is missing', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const token of ['', undefined]) {
      await expect(closeBillingAccount(billingEnv(token, true), 'user-1')).rejects.toMatchObject({ status: 503, code: 'BILLING_UNAVAILABLE' });
    }
    expect(deleteExternal).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: 'billing_cleanup_unconfigured' }));
    log.mockRestore();
  });

  test('anonymizes the Polar customer by external ID', async () => {
    deleteExternal.mockResolvedValue(undefined);
    await closeBillingAccount(billingEnv('polar-token', true), 'user-1');
    expect(deleteExternal).toHaveBeenCalledWith({ externalId: 'user-1', anonymize: true });
  });

  test('treats a missing Polar customer as already closed', async () => {
    deleteExternal.mockRejectedValue(polarError(404));
    await expect(closeBillingAccount(billingEnv('polar-token', false), 'user-1')).resolves.toBeUndefined();
  });

  test('stops deletion when Polar rejects the request', async () => {
    deleteExternal.mockRejectedValue(polarError(401));
    await expect(closeBillingAccount(billingEnv('polar-token', true), 'user-1')).rejects.toThrow('Status 401');
  });
});

describe('renewing subscription guard on account deletion', () => {
  const configured = { POLAR_ACCESS_TOKEN: 'polar-token' } as unknown as Env;
  beforeEach(() => { getStateExternal.mockReset(); });

  test('asks Polar and blocks a subscription that will renew', async () => {
    getStateExternal.mockResolvedValue({ activeSubscriptions: [{ status: 'active', cancelAtPeriodEnd: false }] });
    await expect(requireNoRenewingSubscription(configured, 'user-1')).rejects.toMatchObject({ status: 409, code: 'SUBSCRIPTION_ACTIVE' });
    expect(getStateExternal).toHaveBeenCalledWith({ externalId: 'user-1' });

    getStateExternal.mockResolvedValue({ activeSubscriptions: [{ status: 'active', cancelAtPeriodEnd: true }, { status: 'trialing', cancelAtPeriodEnd: false }] });
    await expect(requireNoRenewingSubscription(configured, 'user-1')).rejects.toMatchObject({ status: 409 });
  });

  test('allows subscriptions set to cancel, no subscriptions, and users Polar has never seen', async () => {
    getStateExternal.mockResolvedValue({ activeSubscriptions: [{ status: 'active', cancelAtPeriodEnd: true }] });
    await expect(requireNoRenewingSubscription(configured, 'user-1')).resolves.toBeUndefined();
    getStateExternal.mockResolvedValue({ activeSubscriptions: [] });
    await expect(requireNoRenewingSubscription(configured, 'user-1')).resolves.toBeUndefined();
    getStateExternal.mockRejectedValue(polarError(404));
    await expect(requireNoRenewingSubscription(configured, 'user-1')).resolves.toBeUndefined();
  });

  test('stops deletion when Polar cannot answer', async () => {
    getStateExternal.mockRejectedValue(polarError(500));
    await expect(requireNoRenewingSubscription(configured, 'user-1')).rejects.toThrow('Status 500');
  });

  test('does not ask Polar without a token', async () => {
    await expect(requireNoRenewingSubscription({ POLAR_ACCESS_TOKEN: '' } as unknown as Env, 'user-1')).resolves.toBeUndefined();
    expect(getStateExternal).not.toHaveBeenCalled();
  });
});
