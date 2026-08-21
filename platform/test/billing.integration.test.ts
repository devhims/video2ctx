/// <reference types="@cloudflare/vitest-pool-workers/types" />

import type { WebhookCustomerStateChangedPayload } from '@polar-sh/sdk/models/components/webhookcustomerstatechangedpayload';
import type { WebhookOrderPaidPayload } from '@polar-sh/sdk/models/components/webhookorderpaidpayload';
import type { WebhookOrderRefundedPayload } from '@polar-sh/sdk/models/components/webhookorderrefundedpayload';
import { env as workerEnv } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';
import {
  applyPaidOrder,
  applyRefundedOrder,
  syncCustomerState,
  type PaymentWebhookEnv,
} from '../src/lib/billing';

const env = {
  DB: workerEnv.DB,
  POLAR_BUILDER_PRODUCT_ID: 'builder-product',
  BUILDER_MONTHLY_CREDITS: '20000',
  STARTER_ONBOARDING_CREDITS: '1000',
} satisfies PaymentWebhookEnv;

describe('Polar payment queries on D1', () => {
  test('tops up Builder credits and makes Polar retries idempotent', async () => {
    const userId = 'payment-paid-user';
    await createUser(userId);
    await addCredits(userId, 6_500, 'test:opening-balance');
    const payload = paidOrder(userId, 'paid-order');

    await applyPaidOrder(env, payload);

    await expect(balance(userId)).resolves.toBe(20_000);
    await expect(account(userId)).resolves.toMatchObject({ plan: 'builder', status: 'active' });
    await expect(operationCount(userId, 'polar:order:paid-order')).resolves.toBe(1);

    await addCredits(userId, -500, 'test:usage');
    await applyPaidOrder(env, payload);

    await expect(balance(userId)).resolves.toBe(19_500);
    await expect(operationCount(userId, 'polar:order:paid-order')).resolves.toBe(1);
  });

  test('preserves balances already above the Builder allowance', async () => {
    const userId = 'payment-carry-user';
    await createUser(userId);
    await addCredits(userId, 25_000, 'test:opening-balance');

    await applyPaidOrder(env, paidOrder(userId, 'carry-order'));

    await expect(balance(userId)).resolves.toBe(25_000);
  });

  test('refunds reset credits to Starter and lock out stale active state', async () => {
    const userId = 'payment-refund-user';
    await createUser(userId);
    await addCredits(userId, 3_500, 'test:opening-balance');

    await applyRefundedOrder(env, refundedOrder(userId, 'refund-order'));

    await expect(balance(userId)).resolves.toBe(1_000);
    await expect(account(userId)).resolves.toMatchObject({ plan: 'starter', status: 'refunded' });
    await expect(operationCount(userId, 'polar:refund:refund-order')).resolves.toBe(1);

    await addCredits(userId, -100, 'test:post-refund-usage');
    await applyRefundedOrder(env, refundedOrder(userId, 'refund-order'));
    await expect(balance(userId)).resolves.toBe(900);

    await syncCustomerState(env, activeCustomerState(userId));
    await expect(account(userId)).resolves.toMatchObject({ plan: 'starter', status: 'refunded' });
  });

  test('does not let an older webhook overwrite newer billing state', async () => {
    const userId = 'payment-ordering-user';
    await createUser(userId);

    await applyRefundedOrder(env, refundedOrder(userId, 'ordering-order'));
    await applyPaidOrder(env, paidOrder(userId, 'late-paid-order', new Date('2026-08-20T00:00:00.000Z')));

    await expect(account(userId)).resolves.toMatchObject({ plan: 'starter', status: 'refunded' });
    await expect(balance(userId)).resolves.toBe(1_000);
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

async function balance(userId: string): Promise<number> {
  const row = await env.DB.prepare(
    'SELECT COALESCE(SUM(credits),0) AS balance FROM credit_ledger WHERE user_id=?'
  ).bind(userId).first<{ balance: number }>();
  return Number(row?.balance ?? 0);
}

async function account(userId: string): Promise<{ plan: string; status: string } | null> {
  return env.DB.prepare('SELECT plan,status FROM billing_accounts WHERE user_id=?')
    .bind(userId).first<{ plan: string; status: string }>();
}

async function operationCount(userId: string, operationId: string): Promise<number> {
  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS count FROM credit_ledger WHERE user_id=? AND operation_id=?'
  ).bind(userId, operationId).first<{ count: number }>();
  return Number(row?.count ?? 0);
}

function paidOrder(
  userId: string,
  id: string,
  timestamp = new Date('2026-08-22T00:00:00.000Z'),
): WebhookOrderPaidPayload {
  return {
    type: 'order.paid',
    timestamp,
    data: {
      id,
      paid: true,
      productId: 'builder-product',
      customerId: `customer-${userId}`,
      subscriptionId: `subscription-${userId}`,
      billingReason: 'subscription_cycle',
      customer: { externalId: userId },
      subscription: {
        status: 'active',
        cancelAtPeriodEnd: false,
        currentPeriodStart: new Date('2026-08-01T00:00:00.000Z'),
        currentPeriodEnd: new Date('2026-09-01T00:00:00.000Z'),
      },
    },
  } as WebhookOrderPaidPayload;
}

function refundedOrder(userId: string, id: string): WebhookOrderRefundedPayload {
  return {
    ...paidOrder(userId, id),
    type: 'order.refunded',
    timestamp: new Date('2026-08-23T00:00:00.000Z'),
  } as WebhookOrderRefundedPayload;
}

function activeCustomerState(userId: string): WebhookCustomerStateChangedPayload {
  return {
    type: 'customer.state_changed',
    timestamp: new Date('2026-08-24T00:00:00.000Z'),
    data: {
      id: `customer-${userId}`,
      externalId: userId,
      activeSubscriptions: [{
        id: `subscription-${userId}`,
        productId: 'builder-product',
        status: 'active',
        cancelAtPeriodEnd: false,
        currentPeriodStart: new Date('2026-08-01T00:00:00.000Z'),
        currentPeriodEnd: new Date('2026-09-01T00:00:00.000Z'),
      }],
    },
  } as WebhookCustomerStateChangedPayload;
}
