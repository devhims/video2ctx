import { Hono } from 'hono';
import type { App } from '../../types';
import { unsubscribe } from '../../lib/digests';
import { youtubeOAuthCallback } from '../../lib/oauth';
import { ApiError, body, escapeHtml, text } from '../../lib/http';
import { claimLandingDemoQuota } from '../../lib/landing-demo';
import { routeInput } from '../../lib/youtube';
import { inspectLandingVideo } from '../../lib/landing-samples';
import { submitScaleInquiry, type ScaleInquiryInput } from '../../lib/scale-inquiries';

export const publicRoutes = new Hono<App>();

publicRoutes.post('/demo/youtube/inspect', async (c) => {
  const payload = await body<{ url?: unknown }>(c.req.raw);
  const input = routeInput(text(payload.url, 500));
  if (input.kind !== 'video') {
    throw new ApiError(422, 'VIDEO_URL_REQUIRED', 'Enter a public YouTube video URL.');
  }

  const quota = await claimLandingDemoQuota(c.env, c.req.raw, input.id);
  const result = await inspectLandingVideo(c.env, input.id, c.req.url, (work) => c.executionCtx.waitUntil(work));
  c.header('X-Demo-Limit', String(quota.limit));
  c.header('X-Demo-Remaining', String(quota.remaining));
  c.header('X-Demo-Reset', quota.resetAt);
  // Quota belongs to this visitor and must never enter the shared snapshot cache.
  c.header('Cache-Control', 'no-store');
  return c.json({ ...result, quota });
});

publicRoutes.post('/scale-inquiries', async (c) => {
  const payload = await body<ScaleInquiryInput>(c.req.raw);
  const result = await submitScaleInquiry(c.env, c.req.raw, payload);
  return c.json(result, 202);
});

publicRoutes.get('/email/unsubscribe', (c) => {
  const user = text(c.req.query('user'), 200);
  const token = text(c.req.query('token'), 500);
  const action = `/v1/email/unsubscribe?user=${encodeURIComponent(user)}&token=${encodeURIComponent(token)}`;
  return c.html(`<!doctype html><html lang="en"><meta name="viewport" content="width=device-width"><title>Turn off video2ctx emails</title><body><main><h1>Turn off email alerts?</h1><p>This stops monitor alerts and digests for your video2ctx account.</p><form method="post" action="${escapeHtml(action)}"><button type="submit">Turn off email alerts</button></form></main></body></html>`);
});

publicRoutes.post('/email/unsubscribe', async (c) => {
  const ok = await unsubscribe(c.env, text(c.req.query('user'), 200), text(c.req.query('token'), 500));
  return ok ? c.text('Email alerts disabled.') : c.text('Invalid unsubscribe link.', 400);
});

publicRoutes.get('/oauth/youtube/callback', async (c) => {
  const code = text(c.req.query('code'), 2000);
  const state = text(c.req.query('state'), 1000);
  if (!code || !state) throw new ApiError(422, 'OAUTH_CALLBACK_INVALID', 'OAuth code and state are required.');
  await youtubeOAuthCallback(c.env, code, state);
  return c.redirect(`${c.env.APP_ORIGIN}/settings/connections?youtube=connected`, 302);
});
