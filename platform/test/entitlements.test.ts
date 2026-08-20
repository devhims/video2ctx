import { creditBalance, entitlements } from '../src/lib/entitlements';

class CreditDatabase {
  balance: number;
  readonly operations = new Set<string>();

  constructor(balance = 0, readonly plan: 'starter' | 'builder' = 'starter') {
    this.balance = balance;
  }

  prepare(sql: string) {
    return {
      bind: (...values: unknown[]) => ({
        first: async () => {
          if (sql.includes('SELECT plan FROM billing_accounts')) return this.plan === 'builder' ? { plan: 'builder' } : null;
          if (sql.includes('SUM(credits)')) return { balance: this.balance };
          return null;
        },
        run: async () => {
          if (!sql.includes('INSERT OR IGNORE INTO credit_ledger')) return { meta: { changes: 0 } };
          const operationId = String(values[2]);
          if (this.operations.has(operationId)) return { meta: { changes: 0 } };
          this.operations.add(operationId);

          if (operationId === 'onboarding:v1') {
            const allowance = Number(values[3]);
            this.balance += Math.max(0, allowance - this.balance);
          }
          return { meta: { changes: 1 } };
        },
      }),
    };
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

  test('grants a new Starter account exactly 1,000 credits once', async () => {
    const database = new CreditDatabase();
    const env = environment(database);

    await expect(creditBalance(env, 'user-1')).resolves.toBe(1000);
    await expect(creditBalance(env, 'user-1')).resolves.toBe(1000);
    expect([...database.operations]).toEqual(['onboarding:v1']);
  });

  test('tops a legacy test account up to the onboarding allowance', async () => {
    const database = new CreditDatabase(96);

    await expect(creditBalance(environment(database), 'user-1')).resolves.toBe(1000);
    expect([...database.operations]).toEqual(['onboarding:v1']);
  });

  test('does not grant Builder credits on a calendar timer', async () => {
    const database = new CreditDatabase(400, 'builder');

    await expect(creditBalance(environment(database), 'user-1')).resolves.toBe(400);
    expect([...database.operations]).toEqual([]);
  });
});
