import Stripe from 'stripe';
import { ApiError, now, sha256 } from './http';

function stripeClient(env: Env): Stripe {
  return new Stripe(env.STRIPE_SECRET_KEY, { httpClient: Stripe.createFetchHttpClient() });
}

export async function createCheckout(env: Env, user: { id: string; email: string }): Promise<string> {
  const stripe = stripeClient(env);
  const existing = await env.DB.prepare('SELECT stripe_customer_id FROM plans WHERE user_id=?')
    .bind(user.id).first<{ stripe_customer_id: string | null }>();
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    ...(existing?.stripe_customer_id ? { customer: existing.stripe_customer_id } : { customer_email: user.email }),
    client_reference_id: user.id,
    line_items: [{ price: env.STRIPE_PRO_PRICE_ID, quantity: 1 }],
    success_url: `${env.APP_ORIGIN}/settings/billing?checkout=success`,
    cancel_url: `${env.APP_ORIGIN}/settings/billing?checkout=cancelled`,
    subscription_data: { metadata: { user_id: user.id } },
    metadata: { user_id: user.id },
  }, { idempotencyKey: `checkout:${user.id}:${new Date().toISOString().slice(0, 10)}` });
  if (!session.url) throw new ApiError(502, 'CHECKOUT_FAILED', 'Stripe did not return a checkout URL.');
  return session.url;
}

export async function processStripeWebhook(env: Env, request: Request): Promise<void> {
  const signature = request.headers.get('stripe-signature');
  if (!signature) throw new ApiError(401, 'STRIPE_SIGNATURE_MISSING', 'Missing Stripe signature.');
  const payload = await request.text();
  const stripe = stripeClient(env);
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      payload, signature, env.STRIPE_WEBHOOK_SECRET, undefined, Stripe.createSubtleCryptoProvider()
    );
  } catch {
    throw new ApiError(401, 'STRIPE_SIGNATURE_INVALID', 'Invalid Stripe signature.');
  }
  const duplicate = await env.DB.prepare('SELECT 1 FROM processed_events WHERE source=? AND event_id=?')
    .bind('stripe', event.id).first();
  if (duplicate) return;

  if (event.type.startsWith('customer.subscription.')) {
    const subscription = event.data.object as Stripe.Subscription;
    const userId = subscription.metadata.user_id;
    if (userId) {
      const active = ['active', 'trialing'].includes(subscription.status);
      const periodEnd = subscription.items.data.reduce((latest, item) => Math.max(latest, item.current_period_end), 0);
      await env.DB.prepare(
        `INSERT INTO plans (user_id,plan,stripe_customer_id,stripe_subscription_id,status,period_end,updated_at)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(user_id) DO UPDATE SET plan=excluded.plan,stripe_customer_id=excluded.stripe_customer_id,
           stripe_subscription_id=excluded.stripe_subscription_id,status=excluded.status,
           period_end=excluded.period_end,updated_at=excluded.updated_at`
      ).bind(
        userId, active ? 'pro' : 'free', String(subscription.customer), subscription.id,
        subscription.status, periodEnd * 1000, now()
      ).run();
    }
  }
  await env.DB.prepare(
    `INSERT OR IGNORE INTO processed_events (source,event_id,processed_at,payload_hash) VALUES ('stripe',?,?,?)`
  ).bind(event.id, now(), await sha256(payload)).run();
}
