import { creditBalance, entitlements } from '../src/lib/entitlements';

class CreditDatabase {
  readonly queries: string[] = [];
  constructor(readonly balance = 0, readonly plan: 'starter' | 'builder' = 'starter') {}
  prepare(sql: string) {
    this.queries.push(sql);
    return { bind: () => ({ first: async () => {
      if (sql.includes('SELECT plan FROM billing_accounts')) return { plan: this.plan };
      if (sql.includes('SELECT available_credits AS balance FROM credit_accounts')) return { balance: this.balance };
      throw new Error('Unexpected credit query');
    } }) };
  }
}

function environment(database: CreditDatabase): Env {
  return {
    DB: database,
    STARTER_ONBOARDING_CREDITS: '1000',
    BUILDER_MONTHLY_CREDITS: '20000',
    STARTER_PROJECT_LIMIT: '3',
    STARTER_MONITOR_LIMIT: '1',
    STARTER_DAILY_IMPORTS: '10',
    BUILDER_PROJECT_LIMIT: '100',
    BUILDER_MONITOR_LIMIT: '50',
    BUILDER_DAILY_IMPORTS: '200',
  } as unknown as Env;
}

describe('credit entitlements', () => {
  test('describes the Starter credit allocation as a one-time onboarding grant', async () => {
    await expect(entitlements(environment(new CreditDatabase()), 'user-1')).resolves.toMatchObject({
      plan: 'starter',
      includedCredits: 1000,
      creditGrant: 'onboarding',
    });
  });

  test('describes the paid allocation as 20,000 recurring monthly credits', async () => {
    await expect(entitlements(environment(new CreditDatabase(0, 'builder')), 'user-1')).resolves.toMatchObject({
      plan: 'builder',
      includedCredits: 20000,
      creditGrant: 'billing-cycle',
    });
  });

  for (const balance of [0, 96, 1000]) test(`reads a Starter balance of ${balance} without changing it`, async () => {
    const database = new CreditDatabase(balance);
    await expect(creditBalance(environment(database), 'user-1')).resolves.toBe(balance);
    expect(database.queries).toEqual(['SELECT available_credits AS balance FROM credit_accounts WHERE user_id = ?']);
  });

  test('reads a Builder balance without checking its plan or granting credits', async () => {
    const database = new CreditDatabase(400, 'builder');
    await expect(creditBalance(environment(database), 'user-1')).resolves.toBe(400);
    expect(database.queries).toHaveLength(1);
    expect(database.queries[0]).not.toContain('billing_accounts');
  });
});
