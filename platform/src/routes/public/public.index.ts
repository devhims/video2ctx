import { Hono } from 'hono';
import type { App } from '../../types';
import { processStripeWebhook } from '../../lib/billing';
import { unsubscribe } from '../../lib/digests';
import { youtubeOAuthCallback } from '../../lib/oauth';
import { ApiError, text } from '../../lib/http';

export const publicRoutes = new Hono<App>();

publicRoutes.post('/billing/webhook', async (c) => {
  await processStripeWebhook(c.env, c.req.raw);
  return c.json({ received: true });
});

publicRoutes.all('/email/unsubscribe', async (c) => {
  const ok = await unsubscribe(c.env, text(c.req.query('user'), 200), text(c.req.query('token'), 500));
  return ok ? c.text('Email digests disabled.') : c.text('Invalid unsubscribe link.', 400);
});

publicRoutes.get('/oauth/youtube/callback', async (c) => {
  const code = text(c.req.query('code'), 2000);
  const state = text(c.req.query('state'), 1000);
  if (!code || !state) throw new ApiError(422, 'OAUTH_CALLBACK_INVALID', 'OAuth code and state are required.');
  await youtubeOAuthCallback(c.env, code, state);
  return c.redirect(`${c.env.APP_ORIGIN}/settings/connections?youtube=connected`, 302);
});
