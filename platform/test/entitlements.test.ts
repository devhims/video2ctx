import { creditBalance, entitlements } from '../src/lib/entitlements';

class CreditDatabase {
  balance: number;
  readonly operations = new Set<string>();

  constructor(balance = 0) {
    this.balance = balance;
  }

  prepare(sql: string) {
    return {
      bind: (...values: unknown[]) => ({
        first: async () => {
          if (sql.includes('SELECT plan FROM plans')) return null;
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
          } else {
            this.balance += Number(values[3]);
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
    FREE_ONBOARDING_CREDITS: '1000',
    PRO_MONTHLY_CREDITS: '2000',
    FREE_PROJECT_LIMIT: '3',
    FREE_MONITOR_LIMIT: '1',
    FREE_DAILY_IMPORTS: '10',
    PRO_PROJECT_LIMIT: '100',
    PRO_MONITOR_LIMIT: '50',
    PRO_DAILY_IMPORTS: '200',
  } as unknown as Env;
}

describe('credit entitlements', () => {
  test('describes the free credit allocation as a one-time onboarding grant', async () => {
    await expect(entitlements(environment(new CreditDatabase()), 'user-1')).resolves.toMatchObject({
      plan: 'free',
      includedCredits: 1000,
      creditGrant: 'onboarding',
    });
  });

  test('grants a new free account exactly 1,000 credits once', async () => {
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
});
