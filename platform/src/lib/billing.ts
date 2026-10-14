import type { WebhookCustomerStateChangedPayload } from '@polar-sh/sdk/models/components/webhookcustomerstatechangedpayload';
import type { WebhookOrderPaidPayload } from '@polar-sh/sdk/models/components/webhookorderpaidpayload';
import type { WebhookOrderRefundedPayload } from '@polar-sh/sdk/models/components/webhookorderrefundedpayload';
import type { WebhookSubscriptionRevokedPayload } from '@polar-sh/sdk/models/components/webhooksubscriptionrevokedpayload';
import { creditBalance } from './entitlements';
import { ApiError, now, sha256 } from './http';

interface BillingAccountRow {
  plan: 'starter' | 'builder';
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
}

export interface PaymentWebhookEnv {
  DB: D1Database;
  POLAR_BUILDER_PRODUCT_ID: string;
  BUILDER_MONTHLY_CREDITS: string;
  STARTER_ONBOARDING_CREDITS: string;
}

export async function getBillingSummary(env: Env, userId: string): Promise<BillingSummary> {
  const [row, balance] = await Promise.all([
    env.DB.prepare(
      `SELECT plan,status,provider_customer_id,provider_subscription_id,cancel_at_period_end,
        current_period_start,current_period_end FROM billing_accounts WHERE user_id=?`
    ).bind(userId).first<BillingAccountRow>(),
    creditBalance(env, userId),
  ]);
  const plan = row?.plan === 'builder' ? 'builder' : 'starter';
  return {
    plan,
    status: row?.status ?? 'inactive',
    creditBalance: balance,
    includedCredits: Number(plan === 'builder' ? env.BUILDER_MONTHLY_CREDITS : env.STARTER_ONBOARDING_CREDITS),
    cancelAtPeriodEnd: row?.cancel_at_period_end === 1,
    currentPeriodStart: row?.current_period_start ?? null,
    currentPeriodEnd: row?.current_period_end ?? null,
    canManageBilling: Boolean(row?.provider_customer_id),
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
  if (!order.paid) throw new Error(`Polar order ${order.id} was not paid.`);

  const userId = order.customer.externalId;
  if (!userId) throw new Error(`Polar order ${order.id} is missing the Better Auth external ID.`);
  const eventId = `order.paid:${order.id}`;
  if (await processed(env.DB, eventId)) return;

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
  if (!userId) throw new Error(`Polar customer ${customer.id} is missing the Better Auth external ID.`);
  if (!await userExists(env.DB, userId)) return;

  const current = await env.DB.prepare('SELECT status FROM billing_accounts WHERE user_id=?')
    .bind(userId).first<{ status: string }>();
  const matchedSubscription = customer.activeSubscriptions.find(
    (candidate) => candidate.productId === env.POLAR_BUILDER_PRODUCT_ID,
  );
  const refundLocked = current?.status === 'refunded';
  const subscription = refundLocked ? undefined : matchedSubscription;
  const eventId = `customer.state_changed:${customer.id}:${payload.timestamp.toISOString()}`;
  if (await processed(env.DB, eventId)) return;

  await env.DB.batch([
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
  const userId = subscription.customer.externalId;
  if (!userId) throw new Error(`Polar subscription ${subscription.id} is missing the Better Auth external ID.`);
  if (!await userExists(env.DB, userId)) return;

  const eventId = `subscription.revoked:${subscription.id}:${payload.timestamp.toISOString()}`;
  if (await processed(env.DB, eventId)) return;
  await env.DB.batch([
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

/** A fully refunded Builder order downgrades the user and resets their balance to Starter. */
export async function applyRefundedOrder(env: PaymentWebhookEnv, payload: WebhookOrderRefundedPayload): Promise<void> {
  const order = payload.data;
  if (order.productId !== env.POLAR_BUILDER_PRODUCT_ID) return;
  const eventId = `order.refunded:${order.id}`;
  if (await processed(env.DB, eventId)) return;

  const userId = order.customer.externalId;
  if (!userId) throw new Error(`Polar refund ${order.id} is missing the Better Auth external ID.`);
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

/** Every subscription Polar holds for a user, or null when Polar has never seen them. */
export type PolarSubscriptionLookup = (env: Env, userId: string) => Promise<Array<{ status: string; cancelAtPeriodEnd: boolean }> | null>;

// Polar's customer state lists only active and trialing subscriptions, but a
// past-due one is still billable and is terminated by customer deletion. Unpaid
// is revoked in Polar, not billable, and can no longer be cancelled.
const BILLABLE_SUBSCRIPTION_STATUSES = new Set(['active', 'trialing', 'past_due']);

const lookupPolarSubscriptions: PolarSubscriptionLookup = async (env, userId) => {
  const { polarClient } = await import('./polar-client');
  let pages;
  try {
    pages = await polarClient(env).subscriptions.list({ externalCustomerId: userId, limit: 100 });
  } catch (cause) {
    // Only a 404 on the first request means Polar has never seen this user.
    if (isHttpStatus(cause, 404)) return null;
    throw cause;
  }
  // A failure on any later page stops deletion rather than discarding what was read.
  const subscriptions: Array<{ status: string; cancelAtPeriodEnd: boolean }> = [];
  for await (const page of pages) subscriptions.push(...page.result.items);
  return subscriptions;
};

/**
 * A billable subscription that will renew must be cancelled before the account is
 * deleted, because Polar's customer deletion terminates it immediately and voids
 * pending orders. Polar is asked directly, across every subscription: the local
 * projection can lag its webhooks and stays Starter after a refund even if a later
 * subscription renews. A subscription already set to cancel at period end may be
 * deleted, forfeiting the remaining period. Any Polar error stops deletion.
 * Without a token Polar cannot be asked, and closeBillingAccount refuses for any
 * user Polar may know.
 */
export async function requireNoRenewingSubscription(
  env: Env,
  userId: string,
  lookup: PolarSubscriptionLookup = lookupPolarSubscriptions,
): Promise<void> {
  if (!env.POLAR_ACCESS_TOKEN) return;
  const subscriptions = await lookup(env, userId);
  if (subscriptions?.some((subscription) => BILLABLE_SUBSCRIPTION_STATUSES.has(subscription.status) && !subscription.cancelAtPeriodEnd)) {
    throw new ApiError(409, 'SUBSCRIPTION_ACTIVE', 'Cancel your Builder plan before deleting your account.');
  }
}

/** Records that checkout is about to reach Polar, so deletion knows a Polar customer may exist. */
export async function recordCheckoutIntent(env: Env, userId: string): Promise<void> {
  await env.DB.prepare('INSERT INTO billing_checkout_intents (user_id,created_at) VALUES (?,?) ON CONFLICT(user_id) DO NOTHING')
    .bind(userId, now()).run();
}

export async function closeBillingAccount(env: Env, userId: string): Promise<void> {
  if (!env.POLAR_ACCESS_TOKEN) {
    // A Polar customer can only come from this app's checkout, which records an
    // intent before contacting Polar, or from a webhook, which writes
    // billing_accounts. With neither, Polar has never seen this user.
    const billed = await env.DB.prepare(
      'SELECT 1 FROM billing_accounts WHERE user_id=? UNION ALL SELECT 1 FROM billing_checkout_intents WHERE user_id=? LIMIT 1'
    ).bind(userId, userId).first();
    if (!billed) return;
    // A known Polar customer must be anonymized before the account, and with it
    // this row, is deleted; afterwards nothing could retry the cleanup.
    console.error({ event: 'billing_cleanup_unconfigured', reason: 'missing_polar_access_token' });
    throw new ApiError(503, 'BILLING_UNAVAILABLE', 'Account deletion is temporarily unavailable. Please try again later or contact support.');
  }
  try {
    const { polarClient } = await import('./polar-client');
    await polarClient(env).customers.deleteExternal({ externalId: userId, anonymize: true });
  } catch (cause) {
    if (isHttpStatus(cause, 404)) return;
    throw cause;
  }
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
