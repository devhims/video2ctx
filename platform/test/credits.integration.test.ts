import { AGENT_CREDIT_RESERVE, reserveAgentCredits, settleAgentCredits } from '../src/agents/runtime/billing';
/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env as workerEnv } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import type { D1Migration } from '@cloudflare/vitest-pool-workers';
import { afterEach, describe, expect, test } from 'vitest';
import { Hono } from 'hono';
import type { App } from '../src/types';
import { meterOperation } from '../src/lib/metering';
import {
  creditBalance,
  entitlements,
  releaseCredits,
  reserveCredits,
  settleCredits,
  settleCreditsAndReadBalance,
  type CreditEnv,
} from '../src/lib/entitlements';

const env = {
  DB: workerEnv.DB,
  STARTER_ONBOARDING_CREDITS: '1000',
  BUILDER_MONTHLY_CREDITS: '20000',
  STARTER_PROJECT_LIMIT: '3',
  STARTER_MONITOR_LIMIT: '1',
  STARTER_DAILY_IMPORTS: '10',
  BUILDER_PROJECT_LIMIT: '100',
  BUILDER_MONITOR_LIMIT: '50',
  BUILDER_DAILY_IMPORTS: '200',
} satisfies CreditEnv;

describe('credit queries on D1', () => {
  test('a stored API read uses two credit round trips and returns the settled balance', async () => {
    const id = 'stored-read-round-trips';
    await createUser(id);
    const tracked = trackRoundTrips(env.DB);
    const app = new Hono<App>();
    app.get('/', async c => {
      c.set('principal', { user: { id, name: 'Reader', email: `${id}@test.example` }, method: 'session', permissions: {} });
      return c.json(await meterOperation(c, { operation: 'video', reservedCredits: 2 }, async () => ({
        value: { saved: true }, actualCredits: 1, cacheStatus: 'hit',
      })));
    });
    const response = await app.request('/', {}, { ...env, DB: tracked.db } as Env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ saved: true });
    expect(response.headers.get('X-Credits-Charged')).toBe('1');
    expect(response.headers.get('X-Credits-Remaining')).toBe('999');
    expect(tracked.calls()).toBe(2);
    expect(await operationCount(id, 'onboarding:v1', 'grant')).toBe(1);
  });

  test('a failed first reservation rolls back its onboarding grant too', async () => {
    const id = 'failed-first-reservation';
    await createUser(id);
    await env.DB.prepare(`CREATE TRIGGER test_fail_first_reservation
      BEFORE INSERT ON credit_ledger WHEN NEW.user_id='failed-first-reservation' AND NEW.entry_type='reserve'
      BEGIN SELECT RAISE(ABORT, 'test reservation failure'); END`).run();
    try {
      await expect(reserveCredits(env, id, 'failure', 1, {})).rejects.toThrow('test reservation failure');
      expect(await operationCount(id, 'onboarding:v1', 'grant')).toBe(0);
      expect(await env.DB.prepare('SELECT available_credits FROM credit_accounts WHERE user_id=?').bind(id).first('available_credits')).toBe(0);
    } finally {
      await env.DB.prepare('DROP TRIGGER test_fail_first_reservation').run();
    }
    await reserveCredits(env, id, 'retry', 1, {});
    expect(await creditBalance(env, id)).toBe(999);
  });

  test('settlement retries return the balance without applying a second refund', async () => {
    const id = 'settle-and-read-retry';
    await createUser(id);
    await reserveCredits(env, id, 'operation', 10, {});
    const balances = await Promise.all([
      settleCreditsAndReadBalance(env, id, 'operation', 10, 3, 0),
      settleCreditsAndReadBalance(env, id, 'operation', 10, 3, 0),
    ]);
    expect(balances).toEqual([997, 997]);
    expect(await operationCount(id, 'operation', 'settle')).toBe(1);
  });

  afterEach(async () => {
    const discrepancies = await env.DB.prepare(`
      SELECT u.id, a.available_credits, COALESCE(SUM(l.credits), 0) AS ledger_balance
      FROM user AS u
      LEFT JOIN credit_accounts AS a ON a.user_id = u.id
      LEFT JOIN credit_ledger AS l ON l.user_id = u.id
      GROUP BY u.id
      HAVING a.user_id IS NULL OR a.available_credits != COALESCE(SUM(l.credits), 0)
    `).all();
    expect(discrepancies.results).toEqual([]);
  });

  test('backfills historical balances and reservations without changing the ledger', async () => {
    const migrationEnv = workerEnv as typeof workerEnv & {
      CREDIT_MIGRATION_DB: D1Database;
      TEST_MIGRATIONS: D1Migration[];
    };
    const db = migrationEnv.CREDIT_MIGRATION_DB;
    const migrationIndex = migrationEnv.TEST_MIGRATIONS.findIndex(m => m.name === '0017_credit_accounts.sql');
    expect(migrationIndex).toBeGreaterThan(0);
    await applyD1Migrations(db, migrationEnv.TEST_MIGRATIONS.slice(0, migrationIndex));
    for (const id of ['historical', 'empty', 'negative']) {
      await db.prepare(`INSERT INTO user (id,name,email,createdAt,updatedAt) VALUES (?,?,?,0,0)`)
        .bind(id, id, `${id}@migration.test`).run();
    }
    await db.prepare(`INSERT INTO credit_ledger
      (id,user_id,operation_id,entry_type,credits,created_at) VALUES
      ('grant','historical','onboarding:v1','grant',1000,0),
      ('reserve','historical','in-progress','reserve',-22,0),
      ('adjustment','negative','legacy','adjustment',-5,0)`
    ).run();
    const before = await db.prepare('SELECT * FROM credit_ledger ORDER BY id').all();
    await applyD1Migrations(db, migrationEnv.TEST_MIGRATIONS);
    expect((await db.prepare('SELECT * FROM credit_accounts ORDER BY user_id').all()).results).toEqual([
      { user_id: 'empty', available_credits: 0 },
      { user_id: 'historical', available_credits: 978 },
      { user_id: 'negative', available_credits: -5 },
    ]);
    expect((await db.prepare('SELECT * FROM credit_ledger ORDER BY id').all()).results).toEqual(before.results);
    await settleAgentCredits({ ...env, DB: db }, 'historical', 'unreserved-cancel', 0, 0);
    await settleCredits({ ...env, DB: db }, 'historical', 'in-progress', 22, 3, 0);
    expect(await creditBalance({ ...env, DB: db }, 'historical')).toBe(997);
  });

  test('manual grants update the stored balance once even when retried concurrently', async () => {
    const id = 'manual-bonus';
    await createUser(id);
    await creditBalance(env, id);
    const grant = () => env.DB.prepare(`INSERT INTO credit_ledger
      (id,user_id,operation_id,entry_type,credits,created_at)
      VALUES (?,?,'manual-bonus','adjustment',10000,?)
      ON CONFLICT(user_id,operation_id,entry_type) DO NOTHING`
    ).bind(crypto.randomUUID(), id, Date.now()).run();
    await Promise.all([grant(), grant()]);
    expect(await creditBalance(env, id)).toBe(11000);
    expect(await operationCount(id, 'manual-bonus', 'adjustment')).toBe(1);
  });

  test('parallel data reservations cannot overdraw an account', async () => {
    const id = 'data-parallel-balance';
    await createUser(id);
    await setBuilderPlan(id);
    await addCredits(id, 10, 'opening');
    const attempts = await Promise.allSettled([
      reserveCredits(env, id, 'request-a', 7, {}),
      reserveCredits(env, id, 'request-b', 7, {}),
    ]);
    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.find(result => result.status === 'rejected')).toMatchObject({
      reason: { status: 402, code: 'INSUFFICIENT_CREDITS' },
    });
    expect(await creditBalance(env, id)).toBe(3);
  });

  test('parallel retries reserve data credits once even when the first attempt spends the balance', async () => {
    const id = 'data-parallel-retry';
    await createUser(id);
    await Promise.all([
      reserveCredits(env, id, 'request', 1000, {}),
      reserveCredits(env, id, 'request', 1000, {}),
    ]);
    expect(await creditBalance(env, id)).toBe(0);
    expect(await operationCount(id, 'request', 'reserve')).toBe(1);
    await Promise.all([
      releaseCredits(env, id, 'request', 1000),
      releaseCredits(env, id, 'request', 1000),
    ]);
    expect(await creditBalance(env, id)).toBe(1000);
  });

  test('a failed balance update rolls back the ledger insertion', async () => {
    const id = 'balance-update-failure';
    await createUser(id);
    await creditBalance(env, id);
    await env.DB.prepare(`CREATE TRIGGER test_reject_balance_update
      BEFORE UPDATE ON credit_accounts WHEN NEW.user_id = 'balance-update-failure'
      BEGIN SELECT RAISE(ABORT, 'test balance failure'); END`).run();
    try {
      await expect(reserveCredits(env, id, 'failed-request', 7, {})).rejects.toThrow('test balance failure');
      expect(await operationCount(id, 'failed-request', 'reserve')).toBe(0);
      expect((await env.DB.prepare('SELECT available_credits FROM credit_accounts WHERE user_id=?')
        .bind(id).first())?.available_credits).toBe(1000);
    } finally {
      await env.DB.prepare('DROP TRIGGER test_reject_balance_update').run();
    }
  });

  test('failed batches roll back both the ledger and balance', async () => {
    const id = 'balance-batch-failure';
    await createUser(id);
    await creditBalance(env, id);
    await expect(env.DB.batch([
      env.DB.prepare(`INSERT INTO credit_ledger (id,user_id,operation_id,entry_type,credits,created_at)
        VALUES ('rollback-entry',?,'rollback','adjustment',10000,0)`).bind(id),
      env.DB.prepare('INSERT INTO credit_accounts (user_id) VALUES (?)').bind('nonexistent-user'),
    ])).rejects.toThrow();
    expect(await creditBalance(env, id)).toBe(1000);
    expect(await operationCount(id, 'rollback', 'adjustment')).toBe(0);
  });

  test('maintenance edits, transfers, and deletions keep balances in sync', async () => {
    const id = 'maintenance-source';
    const other = 'maintenance-target';
    await createUser(id);
    await createUser(other);
    await setBuilderPlan(id);
    await setBuilderPlan(other);
    await addCredits(id, 100, 'maintenance');
    await env.DB.prepare('UPDATE credit_ledger SET credits=250 WHERE user_id=?').bind(id).run();
    expect(await creditBalance(env, id)).toBe(250);
    await env.DB.prepare('UPDATE credit_ledger SET user_id=? WHERE user_id=?').bind(other, id).run();
    expect(await creditBalance(env, id)).toBe(0);
    expect(await creditBalance(env, other)).toBe(250);
    await env.DB.prepare('DELETE FROM credit_ledger WHERE user_id=?').bind(other).run();
    expect(await creditBalance(env, other)).toBe(0);
    await addCredits(other, 50, 'delete-account');
    await env.DB.prepare('DELETE FROM user WHERE id=?').bind(other).run();
    expect(await env.DB.prepare('SELECT * FROM credit_accounts WHERE user_id=?').bind(other).first()).toBeNull();
    expect(await operationCount(other, 'delete-account', 'adjustment')).toBe(0);
  });

  test('balance lookups read bounded rows even with a long ledger history', async () => {
    const id = 'long-credit-history';
    await createUser(id);
    await env.DB.prepare(`WITH RECURSIVE entries(n) AS (
      SELECT 1 UNION ALL SELECT n+1 FROM entries WHERE n<1000
    ) INSERT INTO credit_ledger (id,user_id,operation_id,entry_type,credits,created_at)
      SELECT 'history-' || n, ?, 'history-' || n, 'adjustment', 1, 0 FROM entries`).bind(id).run();
    const result = await env.DB.prepare('SELECT available_credits FROM credit_accounts WHERE user_id=?').bind(id).all();
    expect(result.results).toEqual([{ available_credits: 1000 }]);
    expect(result.meta.rows_read).toBeLessThanOrEqual(3);
  });

  test('agent retries settle once and refund unused credits', async () => {
    const id = 'agent-settlement';
    await createUser(id);
    await Promise.all([reserveAgentCredits(env, id, 'run'), reserveAgentCredits(env, id, 'run')]);
    expect(await creditBalance(env, id)).toBe(1000 - AGENT_CREDIT_RESERVE);
    await Promise.all([settleAgentCredits(env, id, 'run', 3, 42), settleAgentCredits(env, id, 'run', 3, 42)]);
    expect(await creditBalance(env, id)).toBe(997);
    expect(await reserveAgentCredits(env, id, 'run')).toBe(false);
    expect(await operationCount(id, 'agent:run', 'reserve')).toBe(1);
    expect(await operationCount(id, 'agent:run', 'settle')).toBe(1);
  });

  test('cancellation before reservation prevents a late debit or free refund', async () => {
    const id = 'agent-cancel-before-reserve';
    await createUser(id);
    await creditBalance(env, id);
    await settleAgentCredits(env, id, 'cancelled-run', 0, 0);
    expect(await reserveAgentCredits(env, id, 'cancelled-run')).toBe(false);
    expect(await creditBalance(env, id)).toBe(1000);
  });

  test('parallel agent runs cannot overdraw an account', async () => {
    const id = 'agent-parallel-balance';
    await createUser(id);
    await setBuilderPlan(id);
    await addCredits(id, AGENT_CREDIT_RESERVE, 'test:agent-funds');
    const attempts = await Promise.allSettled([
      reserveAgentCredits(env, id, 'run-a'), reserveAgentCredits(env, id, 'run-b'),
    ]);
    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(await creditBalance(env, id)).toBe(0);
    const winner = attempts[0]?.status === 'fulfilled' ? 'run-a' : 'run-b';
    await settleAgentCredits(env, id, winner, 0, 0);
    expect(await creditBalance(env, id)).toBe(AGENT_CREDIT_RESERVE);
  });

  test('grants Starter onboarding credits exactly once', async () => {
    const userId = 'payment-starter-credit-user';
    await createUser(userId);

    await expect(creditBalance(env, userId)).resolves.toBe(1_000);
    await expect(creditBalance(env, userId)).resolves.toBe(1_000);
    await expect(operationCount(userId, 'onboarding:v1', 'grant')).resolves.toBe(1);
  });

  test('tops a pre-existing Starter balance up to the onboarding allowance', async () => {
    const userId = 'payment-legacy-credit-user';
    await createUser(userId);
    await addCredits(userId, 96, 'test:legacy-balance');

    await expect(creditBalance(env, userId)).resolves.toBe(1_000);
  });

  test('does not grant Builder credits outside a paid-order webhook', async () => {
    const userId = 'payment-builder-credit-user';
    await createUser(userId);
    await addCredits(userId, 400, 'test:builder-balance');
    await setBuilderPlan(userId);

    await expect(entitlements(env, userId)).resolves.toMatchObject({
      plan: 'builder',
      includedCredits: 20_000,
      creditGrant: 'billing-cycle',
    });
    await expect(creditBalance(env, userId)).resolves.toBe(400);
  });

  test('reserves, settles, and releases credits idempotently', async () => {
    const userId = 'payment-credit-lifecycle-user';
    await createUser(userId);

    await reserveCredits(env, userId, 'operation:one', 200, { kind: 'test' });
    await reserveCredits(env, userId, 'operation:one', 200, { kind: 'test' });
    await expect(creditBalance(env, userId)).resolves.toBe(800);

    await settleCredits(env, userId, 'operation:one', 200, 120, 500);
    await settleCredits(env, userId, 'operation:one', 200, 120, 500);
    await expect(creditBalance(env, userId)).resolves.toBe(880);

    await reserveCredits(env, userId, 'operation:two', 100, { kind: 'test' });
    await releaseCredits(env, userId, 'operation:two', 100);
    await releaseCredits(env, userId, 'operation:two', 100);
    await expect(creditBalance(env, userId)).resolves.toBe(880);
  });

  test('rejects a reservation larger than the available balance', async () => {
    const userId = 'payment-insufficient-credit-user';
    await createUser(userId);

    await expect(reserveCredits(env, userId, 'operation:too-large', 1_001, {}))
      .rejects.toMatchObject({ status: 402, code: 'INSUFFICIENT_CREDITS' });
    await expect(creditBalance(env, userId)).resolves.toBe(1_000);
  });
});

async function createUser(userId: string): Promise<void> {
  const timestamp = Date.now();
  await env.DB.prepare(
    'INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,?,?,?)'
  ).bind(userId, userId, `${userId}@test.local`, 1, timestamp, timestamp).run();
}

async function addCredits(userId: string, credits: number, operationId: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO credit_ledger
      (id,user_id,operation_id,entry_type,credits,metadata_json,created_at)
     VALUES (?,?,?,'adjustment',?,'{}',?)`
  ).bind(crypto.randomUUID(), userId, operationId, credits, Date.now()).run();
}

async function setBuilderPlan(userId: string): Promise<void> {
  const timestamp = Date.now();
  await env.DB.prepare(
    `INSERT INTO billing_accounts
      (user_id,provider,plan,status,provider_updated_at,updated_at)
     VALUES (?,'polar','builder','active',?,?)`
  ).bind(userId, timestamp, timestamp).run();
}

async function operationCount(userId: string, operationId: string, entryType: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM credit_ledger
     WHERE user_id=? AND operation_id=? AND entry_type=?`
  ).bind(userId, operationId, entryType).first<{ count: number }>();
  return Number(row?.count ?? 0);
}

/** Count binding round trips while running real SQL and triggers in local D1. */
function trackRoundTrips(database: D1Database) {
  let calls = 0;
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  function statement(target: D1PreparedStatement): D1PreparedStatement {
    const wrapped = new Proxy(target, {
      get(inner, key) {
        if (key === 'bind') return (...values: unknown[]) => statement(inner.bind(...values));
        const value = Reflect.get(inner, key);
        if (['first', 'all', 'run', 'raw'].includes(String(key))) {
          return (...args: unknown[]) => { calls++; return value.apply(inner, args); };
        }
        return typeof value === 'function' ? value.bind(inner) : value;
      },
    });
    originals.set(wrapped, target);
    return wrapped;
  }
  const db = new Proxy(database, {
    get(target, key) {
      if (key === 'prepare') return (sql: string) => statement(target.prepare(sql));
      if (key === 'batch') return (statements: D1PreparedStatement[]) => {
        calls++;
        return target.batch(statements.map(item => originals.get(item) ?? item));
      };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { db, calls: () => calls };
}
