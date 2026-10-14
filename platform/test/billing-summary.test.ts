vi.mock('../src/lib/entitlements', () => ({ creditBalance: vi.fn(async () => 1000) }));

import { getBillingSummary } from '../src/lib/billing';

function summaryEnv(overrides: Record<string, unknown>): Env {
  return {
    STARTER_ONBOARDING_CREDITS: '1000',
    BUILDER_MONTHLY_CREDITS: '10000',
    DB: { prepare: () => ({ bind: () => ({ first: async () => null }) }) },
    ...overrides,
  } as unknown as Env;
}

describe('billing summary', () => {
  test('offers checkout only when both the Polar token and the Builder product are configured', async () => {
    const cases: Array<[Record<string, unknown>, boolean]> = [
      [{ POLAR_ACCESS_TOKEN: 'polar-token', POLAR_BUILDER_PRODUCT_ID: 'builder-product' }, true],
      [{ POLAR_ACCESS_TOKEN: '', POLAR_BUILDER_PRODUCT_ID: 'builder-product' }, false],
      [{ POLAR_ACCESS_TOKEN: 'polar-token', POLAR_BUILDER_PRODUCT_ID: '' }, false],
      [{}, false],
    ];
    for (const [config, available] of cases) {
      await expect(getBillingSummary(summaryEnv(config), 'user-1')).resolves.toMatchObject({ plan: 'starter', checkoutAvailable: available });
    }
  });
});
