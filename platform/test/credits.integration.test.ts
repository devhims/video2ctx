/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env as workerEnv } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import {
  creditBalance,
  entitlements,
  releaseCredits,
  reserveCredits,
  settleCredits,
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
