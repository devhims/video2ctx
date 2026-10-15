import type { WebhookCustomerStateChangedPayload } from '@polar-sh/sdk/models/components/webhookcustomerstatechangedpayload';
import type { WebhookOrderPaidPayload } from '@polar-sh/sdk/models/components/webhookorderpaidpayload';
import type { WebhookOrderRefundedPayload } from '@polar-sh/sdk/models/components/webhookorderrefundedpayload';
import type { WebhookSubscriptionRevokedPayload } from '@polar-sh/sdk/models/components/webhooksubscriptionrevokedpayload';
import type { WebhookSubscriptionCreatedPayload } from '@polar-sh/sdk/models/components/webhooksubscriptioncreatedpayload';
import type { WebhookSubscriptionUpdatedPayload } from '@polar-sh/sdk/models/components/webhooksubscriptionupdatedpayload';
import type { CreditEnv } from './entitlements';
import { ApiError, now, sha256 } from './http';

interface BillingAccountRow {
  plan: 'starter' | 'builder';
  has_payment_history: number;
  status: string;
  provider_customer_id: string | null;
  provider_subscription_id: string | null;
  cancel_at_period_end: number;
  current_period_start: number | null;
  current_period_end: number | null;
}

interface BillingState {
  userId: string;
  customerId: string;
  subscriptionId: string | null;
  productId: string | null;
  plan: 'starter' | 'builder';
  status: string;
  cancelAtPeriodEnd: boolean;
  currentPeriodStart: number | null;
  currentPeriodEnd: number | null;
  eventAt: number;
}

export interface BillingSummary {
  plan: 'starter' | 'builder';
  status: string;
  creditBalance: number;
  includedCredits: number;
  cancelAtPeriodEnd: boolean;
  currentPeriodStart: number | null;
  currentPeriodEnd: number | null;
  canManageBilling: boolean;
  needsBillingAttention: boolean;
  creditsReady: boolean;
}

export interface PaymentWebhookEnv {
  DB: D1Database;
  POLAR_BUILDER_PRODUCT_ID: string;
  BUILDER_MONTHLY_CREDITS: string;
  STARTER_ONBOARDING_CREDITS: string;
}

export async function getBillingSummary(env: CreditEnv, userId: string): Promise<BillingSummary> {
  // Read fulfillment and balance in one snapshot so a concurrent webhook cannot
  // report ready credits alongside a balance read before the grant committed.
  const row = await env.DB.prepare(`
    SELECT b.plan,b.status,b.has_payment_history,b.provider_customer_id,
      b.provider_subscription_id,b.cancel_at_period_end,b.current_period_start,b.current_period_end,
      COALESCE(c.available_credits,0) AS credit_balance,
      EXISTS (SELECT 1 FROM billing_subscription_states WHERE user_id=u.id
        AND status IN ('incomplete','past_due','unpaid')) AS needs_attention,
      EXISTS (SELECT 1 FROM credit_ledger WHERE user_id=u.id
        AND entry_type='grant' AND operation_id GLOB 'polar:order:*'
        AND created_at >= COALESCE(b.current_period_start,0)) AS credits_ready
    FROM user u LEFT JOIN billing_accounts b ON b.user_id=u.id
      LEFT JOIN credit_accounts c ON c.user_id=u.id WHERE u.id=?
  `).bind(userId).first<BillingAccountRow & {
    credit_balance: number; needs_attention: number; credits_ready: number;
  }>();
  const plan = row?.plan === 'builder' ? 'builder' : 'starter';
  const needsBillingAttention = row?.needs_attention === 1;
  return {
    plan,
    status: row?.status ?? 'inactive',
    creditBalance: row?.credit_balance ?? 0,
    includedCredits: Number(plan === 'builder' ? env.BUILDER_MONTHLY_CREDITS : env.STARTER_ONBOARDING_CREDITS),
    cancelAtPeriodEnd: row?.cancel_at_period_end === 1,
    currentPeriodStart: row?.current_period_start ?? null,
    currentPeriodEnd: row?.current_period_end ?? null,
    // Customer creation alone does not imply a subscription or billing history.
    canManageBilling: needsBillingAttention || Boolean(row?.provider_customer_id
      && (plan === 'builder' || row.has_payment_history === 1)),
    needsBillingAttention,
    creditsReady: plan === 'builder' && row?.credits_ready === 1,
  };
}

/**
 * A paid order is the only event that grants Builder credits. Each order tops
 * the balance up to the plan allowance, so unused credits carry forward without
 * letting the balance grow beyond the included amount on renewal.
 */
export async function applyPaidOrder(env: PaymentWebhookEnv, payload: WebhookOrderPaidPayload): Promise<void> {
  const order = payload.data;
  if (order.productId !== env.POLAR_BUILDER_PRODUCT_ID) return;
  if (!order.paid) throw new ApiError(422, 'POLAR_ORDER_NOT_PAID', `Polar order ${order.id} was not paid.`);

  const eventId = `order.paid:${order.id}`;
  const userId = order.customer.externalId;
  const identity: BillingIdentity = {
    customerId: order.customerId, subscriptionId: order.subscriptionId, orderId: order.id,
    customerUserId: userId ?? null, checkoutUserId: checkoutIdentity(userId, order.metadata?.app_user_id, order.subscription?.metadata?.app_user_id),
  };
  if (await processed(env.DB, eventId)) {
    await repairPaymentHistory(env.DB, identity);
    return;
  }
  if (await rejectMismatchedIdentity(env, payload, eventId, identity)) return;
  if (!userId) throw new ApiError(422, 'POLAR_MISSING_CUSTOMER_EXTERNAL_ID', `Polar order ${order.id} is missing the Better Auth external ID.`);

  if (!await userExists(env.DB, userId)) {
    await recordEvent(env.DB, eventId, eventFingerprint(payload));
    console.warn(JSON.stringify({ event: 'polar_order_without_user', orderId: order.id, userId }));
    return;
  }

  const eventAt = payload.timestamp.getTime();
  const subscription = order.subscription;
  const status = subscription?.status ?? 'active';
  const allowance = Number(env.BUILDER_MONTHLY_CREDITS);
  const metadata = JSON.stringify({
    provider: 'polar',
    kind: 'billing-cycle',
    orderId: order.id,
    billingReason: order.billingReason,
    allowance,
  });
  const state: BillingState = {
    userId,
    customerId: order.customerId,
    subscriptionId: order.subscriptionId,
    productId: order.productId,
    plan: 'builder',
    status,
    cancelAtPeriodEnd: subscription?.cancelAtPeriodEnd ?? false,
    currentPeriodStart: dateMillis(subscription?.currentPeriodStart),
    currentPeriodEnd: dateMillis(subscription?.currentPeriodEnd),
    eventAt,
  };

  await env.DB.batch([
    billingUpsert(env.DB, state),
    paymentHistoryStatement(env.DB, userId, order.customerId),
    ...(order.subscriptionId ? [subscriptionStateStatement(env.DB, {
      userId, customerId: order.customerId, subscriptionId: order.subscriptionId, status, eventAt,
    })] : []),
    env.DB.prepare(
      `INSERT OR IGNORE INTO credit_ledger
       (id,user_id,operation_id,entry_type,credits,metadata_json,created_at)
       SELECT ?,?,?,'grant',CASE WHEN current_balance < ? THEN ? - current_balance ELSE 0 END,?,?
       FROM (
         SELECT available_credits AS current_balance
         FROM credit_accounts WHERE user_id=?
       )
       WHERE EXISTS (
         SELECT 1 FROM billing_accounts
         WHERE user_id=? AND provider_updated_at=? AND plan='builder' AND status=?
       )`
    ).bind(
      crypto.randomUUID(), userId, `polar:order:${order.id}`, allowance, allowance,
      metadata, now(), userId, userId, eventAt, status,
    ),
    eventStatement(env.DB, eventId, await eventFingerprint(payload)),
  ]);
}

export async function syncCustomerState(
  env: PaymentWebhookEnv,
  payload: WebhookCustomerStateChangedPayload,
): Promise<void> {
  const customer = payload.data;
  const userId = customer.externalId;
  const eventId = `customer.state_changed:${customer.id}:${payload.timestamp.toISOString()}`;
  if (await processed(env.DB, eventId)) return;
  const subscriptions = customer.activeSubscriptions.filter(
    (candidate) => candidate.productId === env.POLAR_BUILDER_PRODUCT_ID,
  );
  const mismatched = subscriptions.find((candidate) => candidate.metadata?.app_user_id !== undefined
    && candidate.metadata.app_user_id !== userId);
  const matchedSubscription = mismatched ?? subscriptions[0];
  const identity: BillingIdentity = {
    customerId: customer.id, subscriptionId: matchedSubscription?.id ?? null,
    customerUserId: userId ?? null, checkoutUserId: checkoutIdentity(userId, customer.metadata?.app_user_id,
      ...subscriptions.map((candidate) => candidate.metadata?.app_user_id)),
  };
  if (await rejectMismatchedIdentity(env, payload, eventId, identity)) return;
  if (!userId) throw new ApiError(422, 'POLAR_MISSING_CUSTOMER_EXTERNAL_ID', `Polar customer ${customer.id} is missing the Better Auth external ID.`);
  if (!await userExists(env.DB, userId)) return;
  const current = await env.DB.prepare('SELECT status FROM billing_accounts WHERE user_id=?')
    .bind(userId).first<{ status: string }>();
  const refundLocked = current?.status === 'refunded';
  const subscription = refundLocked ? undefined : matchedSubscription;
  await env.DB.batch([
    ...subscriptions.map((candidate) => subscriptionStateStatement(env.DB, {
      userId, customerId: customer.id, subscriptionId: candidate.id,
      status: candidate.status, eventAt: payload.timestamp.getTime(),
    })),
    billingUpsert(env.DB, {
      userId,
      customerId: customer.id,
      subscriptionId: matchedSubscription?.id ?? null,
      productId: matchedSubscription?.productId ?? null,
      plan: subscription ? 'builder' : 'starter',
      status: refundLocked ? 'refunded' : subscription?.status ?? 'inactive',
      cancelAtPeriodEnd: matchedSubscription?.cancelAtPeriodEnd ?? false,
      currentPeriodStart: dateMillis(matchedSubscription?.currentPeriodStart),
      currentPeriodEnd: dateMillis(matchedSubscription?.currentPeriodEnd),
      eventAt: payload.timestamp.getTime(),
    }),
    eventStatement(env.DB, eventId, await eventFingerprint(payload)),
  ]);
}

export async function syncRevokedSubscription(
  env: PaymentWebhookEnv,
  payload: WebhookSubscriptionRevokedPayload,
): Promise<void> {
  const subscription = payload.data;
  if (subscription.productId !== env.POLAR_BUILDER_PRODUCT_ID) return;
  const eventId = `subscription.revoked:${subscription.id}:${payload.timestamp.toISOString()}`;
  if (await processed(env.DB, eventId)) return;
  const userId = subscription.customer.externalId;
  const identity: BillingIdentity = {
    customerId: subscription.customerId, subscriptionId: subscription.id,
    customerUserId: userId ?? null, checkoutUserId: subscription.metadata?.app_user_id,
  };
  if (await rejectMismatchedIdentity(env, payload, eventId, identity)) return;
  if (!userId) throw new ApiError(422, 'POLAR_MISSING_CUSTOMER_EXTERNAL_ID', `Polar subscription ${subscription.id} is missing the Better Auth external ID.`);
  if (!await userExists(env.DB, userId)) return;

  await env.DB.batch([
    subscriptionStateStatement(env.DB, {
      userId, customerId: subscription.customerId, subscriptionId: subscription.id,
      status: subscription.status, eventAt: payload.timestamp.getTime(),
    }),
    billingUpsert(env.DB, {
      userId,
      customerId: subscription.customerId,
      subscriptionId: subscription.id,
      productId: subscription.productId,
      plan: 'starter',
      status: subscription.status,
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
      currentPeriodStart: dateMillis(subscription.currentPeriodStart),
      currentPeriodEnd: dateMillis(subscription.currentPeriodEnd),
      eventAt: payload.timestamp.getTime(),
    }),
    eventStatement(env.DB, eventId, await eventFingerprint(payload)),
  ]);
}

/** Subscription events preserve payment problems without changing product access. */
export async function syncSubscriptionState(
  env: PaymentWebhookEnv,
  payload: WebhookSubscriptionCreatedPayload | WebhookSubscriptionUpdatedPayload,
): Promise<void> {
  const subscription = payload.data;
  if (subscription.productId !== env.POLAR_BUILDER_PRODUCT_ID) return;
  const eventId = `${payload.type}:${subscription.id}:${payload.timestamp.toISOString()}`;
  if (await processed(env.DB, eventId)) return;
  const userId = subscription.customer.externalId;
  if (await rejectMismatchedIdentity(env, payload, eventId, {
    customerId: subscription.customerId, subscriptionId: subscription.id,
    customerUserId: userId ?? null, checkoutUserId: subscription.metadata?.app_user_id,
  })) return;
  if (!userId) throw new ApiError(422, 'POLAR_MISSING_CUSTOMER_EXTERNAL_ID', `Polar subscription ${subscription.id} is missing the Better Auth external ID.`);
  if (!await userExists(env.DB, userId)) return;
  await env.DB.batch([
    subscriptionStateStatement(env.DB, {
      userId, customerId: subscription.customerId, subscriptionId: subscription.id,
      status: subscription.status, eventAt: payload.timestamp.getTime(),
    }),
    eventStatement(env.DB, eventId, await eventFingerprint(payload)),
  ]);
}

/** A fully refunded Builder order downgrades the user and resets their balance to Starter. */
export async function applyRefundedOrder(env: PaymentWebhookEnv, payload: WebhookOrderRefundedPayload): Promise<void> {
  const order = payload.data;
  if (order.productId !== env.POLAR_BUILDER_PRODUCT_ID) return;
  const eventId = `order.refunded:${order.id}`;

  const userId = order.customer.externalId;
  const identity: BillingIdentity = {
    customerId: order.customerId, subscriptionId: order.subscriptionId, orderId: order.id,
    customerUserId: userId ?? null, checkoutUserId: checkoutIdentity(userId, order.metadata?.app_user_id, order.subscription?.metadata?.app_user_id),
  };
  if (await processed(env.DB, eventId)) {
    await repairPaymentHistory(env.DB, identity);
    return;
  }
  if (await rejectMismatchedIdentity(env, payload, eventId, identity)) return;
  if (!userId) throw new ApiError(422, 'POLAR_MISSING_CUSTOMER_EXTERNAL_ID', `Polar refund ${order.id} is missing the Better Auth external ID.`);
  if (!await userExists(env.DB, userId)) {
    await recordEvent(env.DB, eventId, eventFingerprint(payload));
    console.warn(JSON.stringify({ event: 'polar_refund_without_user', orderId: order.id, userId }));
    return;
  }

  const starterCredits = Number(env.STARTER_ONBOARDING_CREDITS);
  const subscription = order.subscription;
  const eventAt = payload.timestamp.getTime();
  const state: BillingState = {
    userId,
    customerId: order.customerId,
    subscriptionId: order.subscriptionId,
    productId: order.productId,
    plan: 'starter',
    status: 'refunded',
    cancelAtPeriodEnd: subscription?.cancelAtPeriodEnd ?? false,
    currentPeriodStart: dateMillis(subscription?.currentPeriodStart),
    currentPeriodEnd: dateMillis(subscription?.currentPeriodEnd),
    eventAt,
  };
  await env.DB.batch([
    billingUpsert(env.DB, state),
    paymentHistoryStatement(env.DB, userId, order.customerId),
    env.DB.prepare(
      `INSERT OR IGNORE INTO credit_ledger
       (id,user_id,operation_id,entry_type,credits,metadata_json,created_at)
       SELECT ?,?,?,'adjustment',? - current_balance,?,?
       FROM (
         SELECT available_credits AS current_balance
         FROM credit_accounts WHERE user_id=?
       )
       WHERE EXISTS (
         SELECT 1 FROM billing_accounts
         WHERE user_id=? AND provider_updated_at=? AND plan='starter' AND status='refunded'
       )`
    ).bind(
      crypto.randomUUID(), userId, `polar:refund:${order.id}`, starterCredits,
      JSON.stringify({ provider: 'polar', kind: 'refund-reset', orderId: order.id, balance: starterCredits }),
      now(), userId, userId, eventAt,
    ),
    eventStatement(env.DB, eventId, await eventFingerprint(payload)),
  ]);
}

export async function closeBillingAccount(env: Env, userId: string): Promise<void> {
  try {
    const { polarClient } = await import('./polar-client');
    await polarClient(env).customers.deleteExternal({ externalId: userId, anonymize: true });
  } catch (cause) {
    if (isHttpStatus(cause, 404)) return;
    throw cause;
  }
}

function checkoutIdentity(customerUserId: string | null | undefined, ...values: unknown[]): unknown {
  const supplied = values.filter((value) => value !== undefined);
  const mismatch = supplied.findIndex((value) => value !== customerUserId);
  return mismatch === -1 ? supplied[0] : supplied[mismatch];
}

type BillingEvent = WebhookOrderPaidPayload | WebhookOrderRefundedPayload
  | WebhookCustomerStateChangedPayload | WebhookSubscriptionRevokedPayload
  | WebhookSubscriptionCreatedPayload | WebhookSubscriptionUpdatedPayload;

interface BillingIdentity {
  customerId: string;
  subscriptionId: string | null;
  customerUserId: string | null;
  checkoutUserId: unknown;
  orderId?: string;
}

/** Invalid ownership is terminal for this event, never a freeze on the customer. */
async function rejectMismatchedIdentity(
  env: PaymentWebhookEnv,
  payload: BillingEvent,
  eventId: string,
  identity: BillingIdentity,
): Promise<boolean> {
  const expected = identity.checkoutUserId;
  if (expected === undefined || expected === identity.customerUserId) return false;
  await recordEvent(env.DB, eventId, eventFingerprint(payload));
  console.error({ event: 'polar_billing_identity_mismatch', severity: 'error', eventId, eventType: payload.type,
    orderId: identity.orderId, customerId: identity.customerId, subscriptionId: identity.subscriptionId,
    checkoutUserId: typeof expected === 'string' ? expected : null, customerUserId: identity.customerUserId });
  return true;
}

function paymentHistoryStatement(db: D1Database, userId: string, customerId: string): D1PreparedStatement {
  return db.prepare(
    `UPDATE billing_accounts SET has_payment_history=1
     WHERE user_id=? AND provider_customer_id=? AND has_payment_history=0`
  ).bind(userId, customerId);
}

/** Older deployments acknowledged some payments without a ledger entry. */
async function repairPaymentHistory(db: D1Database, identity: BillingIdentity): Promise<void> {
  if (!identity.customerUserId || (identity.checkoutUserId !== undefined
    && identity.checkoutUserId !== identity.customerUserId)) return;
  // Replay repairs only history for the same existing customer. Never reapply
  // credits, resurrect a deleted account, or accept a rejected ownership claim.
  await paymentHistoryStatement(db, identity.customerUserId, identity.customerId).run();
}

function subscriptionStateStatement(db: D1Database, state: {
  userId: string; customerId: string; subscriptionId: string; status: string; eventAt: number;
}): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO billing_subscription_states
      (subscription_id,user_id,customer_id,status,provider_updated_at) VALUES (?,?,?,?,?)
     ON CONFLICT(subscription_id) DO UPDATE SET
       status=excluded.status,provider_updated_at=excluded.provider_updated_at
     WHERE excluded.user_id=billing_subscription_states.user_id
       AND excluded.customer_id=billing_subscription_states.customer_id
       AND excluded.provider_updated_at >= billing_subscription_states.provider_updated_at`
  ).bind(state.subscriptionId, state.userId, state.customerId, state.status, state.eventAt);
}

function billingUpsert(db: D1Database, state: BillingState): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO billing_accounts
      (user_id,provider,provider_customer_id,provider_subscription_id,provider_product_id,plan,status,
       cancel_at_period_end,current_period_start,current_period_end,provider_updated_at,updated_at)
     VALUES (?,'polar',?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET
       provider_customer_id=excluded.provider_customer_id,
       provider_subscription_id=excluded.provider_subscription_id,
       provider_product_id=excluded.provider_product_id,
       plan=excluded.plan,
       status=excluded.status,
       cancel_at_period_end=excluded.cancel_at_period_end,
       current_period_start=excluded.current_period_start,
       current_period_end=excluded.current_period_end,
       provider_updated_at=excluded.provider_updated_at,
       updated_at=excluded.updated_at
     WHERE excluded.provider_updated_at >= billing_accounts.provider_updated_at`
  ).bind(
    state.userId, state.customerId, state.subscriptionId, state.productId, state.plan, state.status,
    state.cancelAtPeriodEnd ? 1 : 0, state.currentPeriodStart, state.currentPeriodEnd, state.eventAt, now(),
  );
}

function eventStatement(db: D1Database, eventId: string, fingerprint: string): D1PreparedStatement {
  return db.prepare(
    `INSERT OR IGNORE INTO processed_events (source,event_id,processed_at,payload_hash) VALUES ('polar',?,?,?)`
  ).bind(eventId, now(), fingerprint);
}

async function recordEvent(db: D1Database, eventId: string, fingerprint: Promise<string>): Promise<void> {
  await eventStatement(db, eventId, await fingerprint).run();
}

async function processed(db: D1Database, eventId: string): Promise<boolean> {
  return Boolean(await db.prepare(
    `SELECT 1 FROM processed_events WHERE source='polar' AND event_id=?`
  ).bind(eventId).first());
}

async function userExists(db: D1Database, userId: string): Promise<boolean> {
  return Boolean(await db.prepare('SELECT 1 FROM user WHERE id=?').bind(userId).first());
}

function eventFingerprint(payload: unknown): Promise<string> {
  return sha256(JSON.stringify(payload));
}

function dateMillis(value: Date | null | undefined): number | null {
  return value ? value.getTime() : null;
}

function isHttpStatus(cause: unknown, statusCode: number): boolean {
  return typeof cause === 'object' && cause !== null && 'statusCode' in cause
    && (cause as { statusCode?: unknown }).statusCode === statusCode;
}
