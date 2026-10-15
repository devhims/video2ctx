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
  test.each(['paid', 'paid existing projection', 'customer state', 'refund', 'refund existing projection', 'revocation'])(
    'quarantine committed during a %s event prevents its later billing mutations', async (kind) => {
      const userId = `quarantine-race-${kind.replaceAll(' ', '-')}`;
      const payer = `${userId}-payer`;
      await createUser(userId);
      await createUser(payer);
      if (kind === 'refund' || kind === 'revocation') await applyPaidOrder(env, paidOrder(userId, `${userId}-opening`));
      if (kind === 'paid existing projection') {
        await applyPaidOrder(env, paidOrder(userId, `${userId}-opening`));
        await addCredits(userId, -500, `${userId}-usage`);
      }
      if (kind === 'refund existing projection') {
        await applyRefundedOrder(env, refundedOrder(userId, `${userId}-opening`));
        await addCredits(userId, 9000, `${userId}-adjustment`);
      }
      const before = await account(userId);
      const beforeBalance = await balance(userId);
      const conflict = paidOrder(userId, `${userId}-conflict`);
      conflict.data.metadata = { app_user_id: payer };
      const realBatch = env.DB.batch.bind(env.DB);
      const logs = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const batch = vi.spyOn(env.DB, 'batch').mockImplementationOnce(async (statements) => {
        // The original event has finished its reads. Commit another event's
        // quarantine before allowing its previously prepared writes to execute.
        await applyPaidOrder(env, conflict);
        return realBatch(statements);
      });
      try {
        if (kind.startsWith('paid')) await applyPaidOrder(env, paidOrder(userId, `${userId}-valid`));
        if (kind === 'customer state') await syncCustomerState(env, activeCustomerState(userId));
        if (kind.startsWith('refund')) await applyRefundedOrder(env, refundedOrder(userId, `${userId}-valid`));
        if (kind === 'revocation') await syncRevokedSubscription(env, revokedSubscription(userId));
        await expect(account(userId)).resolves.toEqual(before);
        await expect(balance(userId)).resolves.toBe(beforeBalance);
        await expect(operationCount(userId, `polar:order:${userId}-valid`)).resolves.toBe(0);
        await expect(operationCount(userId, `polar:refund:${userId}-valid`)).resolves.toBe(0);
        const conflicts = await env.DB.prepare('SELECT checkout_user_id FROM polar_billing_conflicts WHERE customer_id=?')
          .bind(conflict.data.customerId).all();
        expect(conflicts.results).toHaveLength(2);
        expect(conflicts.results.every(row => row.checkout_user_id === payer)).toBe(true);
      } finally { batch.mockRestore(); logs.mockRestore(); }
    });

  test('concurrent initial conflicts create one alert for the same payer and customer', async () => {
    const userId = 'concurrent-conflict-customer';
    const payer = 'concurrent-conflict-payer';
    await createUser(userId);
    await createUser(payer);
    const first = paidOrder(userId, 'concurrent-conflict-first');
    const second = paidOrder(userId, 'concurrent-conflict-second');
    first.data.metadata = second.data.metadata = { app_user_id: payer };
    const realBatch = env.DB.batch.bind(env.DB);
    let arrivals = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const logs = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const batch = vi.spyOn(env.DB, 'batch').mockImplementation(async (statements) => {
      if (++arrivals <= 2) {
        if (arrivals === 2) release();
        await gate;
      }
      return realBatch(statements);
    });
    try {
      await Promise.all([applyPaidOrder(env, first), applyPaidOrder(env, second)]);
      const alerts = await env.DB.prepare("SELECT id FROM notifications WHERE user_id=? AND type='billing_attention'").bind(payer).all();
      expect(alerts.results).toHaveLength(1);
      const conflicts = await env.DB.prepare('SELECT id FROM polar_billing_conflicts WHERE customer_id=?').bind(first.data.customerId).all();
      expect(conflicts.results).toHaveLength(2);
      await expect(balance(userId)).resolves.toBe(1000);
      await expect(balance(payer)).resolves.toBe(1000);
    } finally { batch.mockRestore(); logs.mockRestore(); }
  });

  test.each(['different payers', 'different customers'])('alert deduplication preserves alerts for %s', async (scope) => {
    const suffix = scope.replaceAll(' ', '-');
    const firstCustomer = `alert-scope-customer-${suffix}`;
    const secondCustomer = scope === 'different customers' ? `${firstCustomer}-second` : firstCustomer;
    const firstPayer = `alert-scope-payer-${suffix}`;
    const secondPayer = scope === 'different payers' ? `${firstPayer}-second` : firstPayer;
    for (const userId of new Set([firstCustomer, secondCustomer, firstPayer, secondPayer])) await createUser(userId);
    const first = paidOrder(firstCustomer, `alert-scope-first-${suffix}`);
    const second = paidOrder(secondCustomer, `alert-scope-second-${suffix}`);
    first.data.metadata = { app_user_id: firstPayer };
    second.data.metadata = { app_user_id: secondPayer };
    const logs = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await Promise.all([applyPaidOrder(env, first), applyPaidOrder(env, second)]);
      const alerts = await env.DB.prepare("SELECT user_id FROM notifications WHERE type='billing_attention' AND user_id IN (?,?)")
        .bind(firstPayer, secondPayer).all();
      expect(alerts.results).toHaveLength(2);
      expect(alerts.results).toContainEqual({ user_id: firstPayer });
      expect(alerts.results).toContainEqual({ user_id: secondPayer });
    } finally { logs.mockRestore(); }
  });

  test('a new conflict after reconciliation gets a new alert', async () => {
    const userId = 'reconciled-conflict-customer';
    const payer = 'reconciled-conflict-payer';
    await createUser(userId);
    await createUser(payer);
    const first = paidOrder(userId, 'reconciled-conflict-first');
    first.data.metadata = { app_user_id: payer };
    const logs = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await applyPaidOrder(env, first);
      await env.DB.prepare('UPDATE polar_billing_conflicts SET resolved_at=? WHERE customer_id=?').bind(Date.now(), first.data.customerId).run();
      const second = paidOrder(userId, 'reconciled-conflict-second');
      second.data.metadata = { app_user_id: payer };
      await applyPaidOrder(env, second);
      const alerts = await env.DB.prepare("SELECT id FROM notifications WHERE user_id=? AND type='billing_attention'").bind(payer).all();
      expect(alerts.results).toHaveLength(2);
    } finally { logs.mockRestore(); }
  });

  test('records a mismatched payment once, alerts the payer, and blocks later customer updates', async () => {
    const customerUser = 'identity-existing-customer';
    const payer = 'identity-checkout-payer';
    await createUser(customerUser);
    await createUser(payer);
    const payload = paidOrder(customerUser, 'mismatched-customer-order');
    payload.data.metadata = { app_user_id: payer };
    const alerts = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await applyPaidOrder(env, payload);
      await applyPaidOrder(env, payload);
      // The later customer snapshot omits metadata, so the recorded conflict must still protect it.
      await syncCustomerState(env, activeCustomerState(customerUser));
      await expect(balance(customerUser)).resolves.toBe(1000);
      await expect(balance(payer)).resolves.toBe(1000);
      await expect(account(customerUser)).resolves.toBeNull();
      await expect(account(payer)).resolves.toBeNull();
      await expect(operationCount(customerUser, 'polar:order:mismatched-customer-order')).resolves.toBe(0);
      const events = await env.DB.prepare("SELECT event_id FROM processed_events WHERE source='polar' AND event_id=?")
        .bind('order.paid:mismatched-customer-order').all();
      expect(events.results).toHaveLength(1);
      const conflicts = await env.DB.prepare('SELECT order_id,checkout_user_id,customer_user_id FROM polar_billing_conflicts').all();
      expect(conflicts.results).toContainEqual(expect.objectContaining({
        order_id: 'mismatched-customer-order', checkout_user_id: payer, customer_user_id: customerUser,
      }));
      const notifications = await env.DB.prepare("SELECT user_id FROM notifications WHERE type='billing_attention' AND user_id=?")
        .bind(payer).all();
      expect(notifications.results).toHaveLength(1);
      expect(alerts).toHaveBeenCalledWith(expect.objectContaining({ event: 'polar_billing_identity_conflict' }));
    } finally { alerts.mockRestore(); }
  });

  test('blocks mismatched customer state even when it arrives before the paid order', async () => {
    const customerUser = 'identity-customer-first';
    const payer = 'identity-customer-first-payer';
    await createUser(customerUser);
    await createUser(payer);
    const state = activeCustomerState(customerUser);
    state.data.activeSubscriptions[0]!.metadata = { app_user_id: payer };
    await syncCustomerState(env, state);
    await expect(account(customerUser)).resolves.toBeNull();
    const payload = paidOrder(customerUser, 'customer-first-order');
    payload.data.metadata = { app_user_id: payer };
    await applyPaidOrder(env, payload);
    await expect(balance(customerUser)).resolves.toBe(1000);
    await expect(balance(payer)).resolves.toBe(1000);
    const conflict = await env.DB.prepare('SELECT order_id FROM polar_billing_conflicts WHERE subscription_id=? AND order_id IS NOT NULL')
      .bind(`subscription-${customerUser}`).first();
    expect(conflict).toMatchObject({ order_id: 'customer-first-order' });
  });

  test('protects existing credits and plans from mismatched refunds and revocations', async () => {
    const customerUser = 'identity-refund-customer';
    await createUser(customerUser);
    await createUser('identity-refund-payer');
    await applyPaidOrder(env, paidOrder(customerUser, 'identity-valid-order'));
    const refund = refundedOrder(customerUser, 'identity-mismatched-refund');
    refund.data.metadata = { app_user_id: 'identity-refund-payer' };
    await applyRefundedOrder(env, refund);
    await syncRevokedSubscription(env, {
      type: 'subscription.revoked', timestamp: new Date('2026-08-24T00:00:00.000Z'),
      data: { ...refund.data.subscription!, id: `subscription-${customerUser}`,
        customerId: refund.data.customerId, customer: refund.data.customer,
        productId: 'builder-product', metadata: { app_user_id: 'identity-refund-payer' }, status: 'canceled',
        product: { ...refund.data.product!, prices: [], benefits: [], medias: [], attachedCustomFields: [] }, discount: null, prices: [], meters: [], pendingUpdate: null },
    } as WebhookSubscriptionRevokedPayload);
    await expect(balance(customerUser)).resolves.toBe(10_000);
    await expect(account(customerUser)).resolves.toMatchObject({ plan: 'builder', status: 'active' });
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
  test.each(['daily', 'weekly'] as const)('does not queue a %s digest for billing-only alerts', async (cadence) => {
    const userId = `billing-only-digest-${cadence}`;
    await digestUser(userId, cadence);
    await digestNotification(userId, 'billing_attention', 'Billing-only title');
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
    // Newer billing alerts must not crowd the monitor out of the 30-item digest.
    for (let index = 0; index < 35; index++) await digestNotification(userId, 'billing_attention', 'Private billing title');
    const send = vi.fn<Queue<EmailMessage>['send']>().mockResolvedValue({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } });
    try {
      await queueDigests({ DB: env.DB, APP_ORIGIN: 'http://auth.test',
        BETTER_AUTH_SECRET: 'test-only-digest-signing-key', EMAIL_TASKS: { send } }, cadence);
      const messages = send.mock.calls.map(([message]) => message).filter(message => message.userId === userId);
      expect(messages).toHaveLength(1);
      expect(messages[0]!.text).toContain('New monitor match title');
      expect(messages[0]!.html).toContain('New monitor match title');
      expect(messages[0]!.text.includes('Private billing title')).toBe(false);
      expect(messages[0]!.html.includes('Private billing title')).toBe(false);
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
