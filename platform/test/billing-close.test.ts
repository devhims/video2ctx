const deleteExternal = vi.hoisted(() => vi.fn());
const listSubscriptions = vi.hoisted(() => vi.fn());
vi.mock('../src/lib/polar-client', () => ({ polarClient: () => ({ customers: { deleteExternal }, subscriptions: { list: listSubscriptions } }) }));

import { closeBillingAccount, requireNoRenewingSubscription } from '../src/lib/billing';

const polarError = (statusCode: number) => Object.assign(new Error(`Status ${statusCode}`), { statusCode });

const billingEnv = { POLAR_ACCESS_TOKEN: 'polar-token' } as unknown as Env;

describe('closing the billing account on account deletion', () => {
  beforeEach(() => { deleteExternal.mockReset(); });

  test('anonymizes the Polar customer by external ID', async () => {
    deleteExternal.mockResolvedValue(undefined);
    await closeBillingAccount(billingEnv, 'user-1');
    expect(deleteExternal).toHaveBeenCalledWith({ externalId: 'user-1', anonymize: true });
  });

  test('treats a missing Polar customer as already closed', async () => {
    deleteExternal.mockRejectedValue(polarError(404));
    await expect(closeBillingAccount(billingEnv, 'user-1')).resolves.toBeUndefined();
  });

  test('stops deletion when Polar rejects the request', async () => {
    deleteExternal.mockRejectedValue(polarError(401));
    await expect(closeBillingAccount(billingEnv, 'user-1')).rejects.toThrow('Status 401');
  });
});

describe('renewing subscription guard on account deletion', () => {
  const configured = { POLAR_ACCESS_TOKEN: 'polar-token' } as unknown as Env;
  type Sub = { status: string; cancelAtPeriodEnd: boolean };
  // Mirrors the SDK's paginated result: awaited once, then iterated page by page.
  const pages = (...items: Array<Sub[] | Error>) => ({
    async *[Symbol.asyncIterator]() {
      for (const page of items) {
        if (page instanceof Error) throw page;
        yield { result: { items: page } };
      }
    },
  });
  beforeEach(() => { listSubscriptions.mockReset(); });

  test('asks Polar for every subscription and blocks billable ones that will renew', async () => {
    for (const status of ['active', 'trialing', 'past_due']) {
      listSubscriptions.mockResolvedValue(pages([{ status, cancelAtPeriodEnd: false }]));
      await expect(requireNoRenewingSubscription(configured, 'user-1')).rejects.toMatchObject({ status: 409, code: 'SUBSCRIPTION_ACTIVE' });
    }
    expect(listSubscriptions).toHaveBeenCalledWith({ externalCustomerId: 'user-1', limit: 100 });
  });

  test('finds a renewing subscription on a later page', async () => {
    listSubscriptions.mockResolvedValue(pages([{ status: 'canceled', cancelAtPeriodEnd: false }], [{ status: 'past_due', cancelAtPeriodEnd: false }]));
    await expect(requireNoRenewingSubscription(configured, 'user-1')).rejects.toMatchObject({ status: 409 });
  });

  test('allows ended, revoked, never-started and cancelling subscriptions, and users Polar has never seen', async () => {
    listSubscriptions.mockResolvedValue(pages([
      { status: 'canceled', cancelAtPeriodEnd: false },
      // Unpaid is revoked in Polar and cannot be cancelled, so historical ones must not block forever.
      { status: 'unpaid', cancelAtPeriodEnd: false },
      { status: 'incomplete_expired', cancelAtPeriodEnd: false },
      { status: 'incomplete', cancelAtPeriodEnd: false },
      { status: 'active', cancelAtPeriodEnd: true },
      { status: 'trialing', cancelAtPeriodEnd: true },
      { status: 'past_due', cancelAtPeriodEnd: true },
    ]));
    await expect(requireNoRenewingSubscription(configured, 'user-1')).resolves.toBeUndefined();
    listSubscriptions.mockResolvedValue(pages([]));
    await expect(requireNoRenewingSubscription(configured, 'user-1')).resolves.toBeUndefined();
    listSubscriptions.mockRejectedValue(polarError(404));
    await expect(requireNoRenewingSubscription(configured, 'user-1')).resolves.toBeUndefined();
  });

  test('stops deletion when Polar cannot answer', async () => {
    listSubscriptions.mockRejectedValue(polarError(500));
    await expect(requireNoRenewingSubscription(configured, 'user-1')).rejects.toThrow('Status 500');
  });

  test('a failed later page stops deletion instead of discarding what was read', async () => {
    listSubscriptions.mockResolvedValue(pages([{ status: 'active', cancelAtPeriodEnd: false }], polarError(404)));
    await expect(requireNoRenewingSubscription(configured, 'user-1')).rejects.toThrow('Status 404');
    listSubscriptions.mockResolvedValue(pages([{ status: 'canceled', cancelAtPeriodEnd: false }], polarError(503)));
    await expect(requireNoRenewingSubscription(configured, 'user-1')).rejects.toThrow('Status 503');
  });

  test('refuses deletion before asking Polar when its token is missing', async () => {
    await expect(requireNoRenewingSubscription({ POLAR_ACCESS_TOKEN: '' } as unknown as Env, 'user-1')).rejects.toMatchObject({ status: 503, code: 'BILLING_UNAVAILABLE' });
    expect(listSubscriptions).not.toHaveBeenCalled();
  });
});
