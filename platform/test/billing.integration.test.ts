/// <reference types="@cloudflare/vitest-pool-workers/types" />

import type { WebhookCustomerStateChangedPayload } from '@polar-sh/sdk/models/components/webhookcustomerstatechangedpayload';
import type { WebhookOrderPaidPayload } from '@polar-sh/sdk/models/components/webhookorderpaidpayload';
import type { WebhookSubscriptionRevokedPayload } from '@polar-sh/sdk/models/components/webhooksubscriptionrevokedpayload';
import type { WebhookOrderRefundedPayload } from '@polar-sh/sdk/models/components/webhookorderrefundedpayload';
import { env as workerEnv } from 'cloudflare:workers';
import { describe, expect, test, vi } from 'vitest';
import {
  applyPaidOrder,
  applyRefundedOrder,
  syncCustomerState,
  syncRevokedSubscription,
  type PaymentWebhookEnv,
} from '../src/lib/billing';
import { queueDigests } from '../src/lib/digests';
import type { EmailMessage } from '../src/types';

const env = {
  DB: workerEnv.DB,
  POLAR_BUILDER_PRODUCT_ID: 'builder-product',
  BUILDER_MONTHLY_CREDITS: '10000',
  STARTER_ONBOARDING_CREDITS: '1000',
} satisfies PaymentWebhookEnv;

describe('Polar payment queries on D1', () => {
  test.each(['paid', 'customer state', 'refund', 'revocation'])(
    'skips a mismatched %s event once without changing either account', async (kind) => {
      const userId = `identity-rejected-${kind.replaceAll(' ', '-')}`;
      const payer = `${userId}-payer`;
      await createUser(userId);
      await createUser(payer);
      if (kind === 'refund' || kind === 'revocation') await applyPaidOrder(env, paidOrder(userId, `${userId}-opening`));
      const before = await account(userId);
      const beforeBalance = await balance(userId);
      const order = paidOrder(userId, `${userId}-mismatched`);
      order.data.metadata = { app_user_id: payer };
      const customer = activeCustomerState(userId);
      customer.data.activeSubscriptions[0]!.metadata = { app_user_id: payer };
      const refund = refundedOrder(userId, order.data.id);
      refund.data.metadata = { app_user_id: payer };
      const revoked = revokedSubscription(userId);
      revoked.data.metadata = { app_user_id: payer };
      const logs = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          if (kind === 'paid') await applyPaidOrder(env, order);
          if (kind === 'customer state') await syncCustomerState(env, customer);
          if (kind === 'refund') await applyRefundedOrder(env, refund);
          if (kind === 'revocation') await syncRevokedSubscription(env, revoked);
        }
        await expect(account(userId)).resolves.toEqual(before);
        await expect(balance(userId)).resolves.toBe(beforeBalance);
        await expect(account(payer)).resolves.toBeNull();
        await expect(balance(payer)).resolves.toBe(1000);
        await expect(operationCount(userId, `polar:order:${order.data.id}`)).resolves.toBe(0);
        await expect(operationCount(userId, `polar:refund:${order.data.id}`)).resolves.toBe(0);
        expect(logs).toHaveBeenCalledOnce();
        expect(logs).toHaveBeenCalledWith(expect.objectContaining({
          event: 'polar_billing_identity_mismatch', customerId: order.data.customerId,
          checkoutUserId: payer, customerUserId: userId,
        }));
        const markers = await env.DB.prepare("SELECT event_id FROM processed_events WHERE source='polar'").all();
        expect(markers.results.filter(row => String(row.event_id).includes(kind === 'customer state' ? customer.data.id
          : kind === 'revocation' ? revoked.data.id : order.data.id))).toHaveLength(1);
        const notifications = await env.DB.prepare('SELECT id FROM notifications WHERE user_id IN (?,?)').bind(userId, payer).all();
        expect(notifications.results).toHaveLength(0);
      } finally { logs.mockRestore(); }
    });

  test('a rejected event does not freeze later correctly owned billing events', async () => {
    const userId = 'identity-no-persistent-freeze';
    const payer = 'identity-other-account';
    await createUser(userId);
    await createUser(payer);
    const mismatched = paidOrder(userId, 'identity-rejected-order');
    mismatched.data.metadata = { app_user_id: payer };
    const logs = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await applyPaidOrder(env, mismatched);
      const customer = activeCustomerState(userId);
      customer.data.activeSubscriptions[0]!.metadata = { app_user_id: userId };
      await syncCustomerState(env, customer);
      await expect(account(userId)).resolves.toMatchObject({ plan: 'builder', status: 'active' });
      await expect(balance(userId)).resolves.toBe(1000);
      const paid = paidOrder(userId, 'identity-correct-order', new Date('2026-08-25T00:00:00.000Z'));
      paid.data.metadata = { app_user_id: userId };
      await applyPaidOrder(env, paid);
      await expect(balance(userId)).resolves.toBe(10_000);
      await expect(balance(payer)).resolves.toBe(1000);
    } finally { logs.mockRestore(); }
  });

  test('accepts matching subscription identity in a customer state update', async () => {
    const userId = 'identity-matching-customer-state';
    await createUser(userId);
    const state = activeCustomerState(userId);
    state.data.activeSubscriptions[0]!.metadata = { app_user_id: userId };
    await syncCustomerState(env, state);
    await expect(account(userId)).resolves.toMatchObject({ plan: 'builder', status: 'active' });
    await expect(balance(userId)).resolves.toBe(1000);
  });

  test('uses the current configured 10,000-credit Builder allowance', async () => {
    const userId = 'payment-current-builder-allowance';
    await createUser(userId);
    const payload = paidOrder(userId, 'current-builder-order');
    payload.data.metadata = { app_user_id: userId };
    await applyPaidOrder({ ...env, BUILDER_MONTHLY_CREDITS: '10000' }, payload);
    await expect(balance(userId)).resolves.toBe(10_000);
    await expect(account(userId)).resolves.toMatchObject({ plan: 'builder', status: 'active' });
    await expect(operationCount(userId, 'polar:order:current-builder-order')).resolves.toBe(1);
  });

  test('tops up Builder credits and makes Polar retries idempotent', async () => {
    const userId = 'payment-paid-user';
    await createUser(userId);
    await addCredits(userId, 6_500, 'test:opening-balance');
    const payload = paidOrder(userId, 'paid-order');
    payload.data.metadata = { app_user_id: userId };

    await applyPaidOrder(env, payload);

    await expect(balance(userId)).resolves.toBe(10_000);
    await expect(account(userId)).resolves.toMatchObject({ plan: 'builder', status: 'active' });
    await expect(operationCount(userId, 'polar:order:paid-order')).resolves.toBe(1);

    await addCredits(userId, -500, 'test:usage');
    await applyPaidOrder(env, payload);

    await expect(balance(userId)).resolves.toBe(9_500);
    await expect(operationCount(userId, 'polar:order:paid-order')).resolves.toBe(1);
  });

  test('preserves balances already above the Builder allowance', async () => {
    const userId = 'payment-carry-user';
    await createUser(userId);
    await addCredits(userId, 24_000, 'test:opening-balance');

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
  const account = await env.DB.prepare(
    'SELECT available_credits AS balance FROM credit_accounts WHERE user_id=?'
  ).bind(userId).first<{ balance: number }>();
  const row = await env.DB.prepare(
    'SELECT COALESCE(SUM(credits),0) AS balance FROM credit_ledger WHERE user_id=?'
  ).bind(userId).first<{ balance: number }>();
  expect(account?.balance).toBe(row?.balance ?? 0);
  return Number(account?.balance ?? 0);
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

function revokedSubscription(userId: string): WebhookSubscriptionRevokedPayload {
  const order = refundedOrder(userId, 'revoked-fixture').data;
  return {
    type: 'subscription.revoked', timestamp: new Date('2026-08-24T00:00:00.000Z'),
    data: { ...order.subscription, id: `subscription-${userId}`, customerId: order.customerId,
      customer: order.customer, productId: 'builder-product', metadata: {}, status: 'canceled' },
  } as WebhookSubscriptionRevokedPayload;
}

describe('Monitor digest notification selection on D1', () => {
  test.each(['daily', 'weekly'] as const)('does not queue a %s digest for non-monitor alerts', async (cadence) => {
    const userId = `non-monitor-digest-${cadence}`;
    await digestUser(userId, cadence);
    await digestNotification(userId, 'account_notice', 'Account-only title');
    const send = vi.fn<Queue<EmailMessage>['send']>().mockResolvedValue({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } });
    try {
      await queueDigests({ DB: env.DB, APP_ORIGIN: 'http://auth.test',
        BETTER_AUTH_SECRET: 'test-only-digest-signing-key', EMAIL_TASKS: { send } }, cadence);
      expect(send.mock.calls.filter(([message]) => message.userId === userId)).toHaveLength(0);
    } finally { send.mockRestore(); }
  });

  test.each(['daily', 'weekly'] as const)('includes only monitor matches in a mixed %s digest', async (cadence) => {
    const userId = `mixed-digest-${cadence}`;
    await digestUser(userId, cadence);
    await digestNotification(userId, 'monitor_match', 'New monitor match title', Date.now() - 1000);
    // Newer non-monitor alerts must not crowd the monitor out of the 30-item digest.
    for (let index = 0; index < 35; index++) await digestNotification(userId, 'account_notice', 'Account notice title');
    const send = vi.fn<Queue<EmailMessage>['send']>().mockResolvedValue({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } });
    try {
      await queueDigests({ DB: env.DB, APP_ORIGIN: 'http://auth.test',
        BETTER_AUTH_SECRET: 'test-only-digest-signing-key', EMAIL_TASKS: { send } }, cadence);
      const messages = send.mock.calls.map(([message]) => message).filter(message => message.userId === userId);
      expect(messages).toHaveLength(1);
      expect(messages[0]!.text).toContain('New monitor match title');
      expect(messages[0]!.html).toContain('New monitor match title');
      expect(messages[0]!.text.includes('Account notice title')).toBe(false);
      expect(messages[0]!.html.includes('Account notice title')).toBe(false);
    } finally { send.mockRestore(); }
  });
});

async function digestUser(userId: string, cadence: 'daily' | 'weekly') {
  await createUser(userId);
  await env.DB.prepare(`INSERT INTO notification_preferences (user_id,in_app,email_alerts,email_digest,email_alerts_verified_at,updated_at)
    VALUES (?,1,1,?,?,?) ON CONFLICT(user_id) DO UPDATE SET email_alerts=1,email_digest=excluded.email_digest,
    email_alerts_verified_at=excluded.email_alerts_verified_at`).bind(userId, cadence, Date.now(), Date.now()).run();
}

async function digestNotification(userId: string, type: string, title: string, createdAt = Date.now()) {
  await env.DB.prepare(`INSERT INTO notifications (id,user_id,type,title,body,data_json,created_at)
    VALUES (?,?,?,?,?,'{}',?)`).bind(crypto.randomUUID(), userId, type, title, `${title} body`, createdAt).run();
}
