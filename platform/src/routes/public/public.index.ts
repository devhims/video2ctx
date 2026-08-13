import { Hono } from 'hono';
import type { App } from '../../types';
import { processStripeWebhook } from '../../lib/billing';
import { unsubscribe } from '../../lib/digests';
import { youtubeOAuthCallback } from '../../lib/oauth';
import { ApiError, body, text } from '../../lib/http';
import { claimLandingDemoQuota, type LandingDemoQuota } from '../../lib/landing-demo';
import { routeInput } from '../../lib/youtube';
import { getProvider } from '../../providers';

export const publicRoutes = new Hono<App>();

publicRoutes.post('/demo/youtube/inspect', async (c) => {
  const payload = await body<{ url?: unknown }>(c.req.raw);
  const input = routeInput(text(payload.url, 500));
  if (input.kind !== 'video') {
    throw new ApiError(422, 'VIDEO_URL_REQUIRED', 'Enter a public YouTube video URL.');
  }

  const quota = await claimLandingDemoQuota(c.env, c.req.raw, input.id);
  const provider = getProvider('youtube');
  const [videoResult, transcriptResult, commentsResult] = await Promise.allSettled([
    provider.getVideo(c.env, input.id),
    provider.getTranscript(c.env, input.id),
    provider.getComments(c.env, input.id),
  ]);

  if (videoResult.status === 'rejected') throw inspectionError(videoResult.reason);

  /* The channel is a second wave: its id only exists once the video resolves.
   * Settled independently for the same reason transcript and comments are —
   * a channel that fails to load must not take the inspection down with it. */
  const channelId = videoResult.value.value.channel?.id;
  const channelResult = channelId
    ? await Promise.allSettled([provider.getChannel(c.env, channelId)])
    : [{ status: 'rejected' as const, reason: undefined }];

  c.header('X-Demo-Limit', String(quota.limit));
  c.header('X-Demo-Remaining', String(quota.remaining));
  c.header('X-Demo-Reset', quota.resetAt);

  const transcript = transcriptResult.status === 'fulfilled'
    ? {
        status: 'ready' as const,
        track: transcriptResult.value.value.track,
        segmentCount: transcriptResult.value.value.segments.length,
        segments: transcriptResult.value.value.segments.slice(0, 16),
      }
    : { status: 'unavailable' as const };
  const comments = commentsResult.status === 'fulfilled'
    ? {
        status: 'ready' as const,
        totalCount: commentsResult.value.value.totalCount,
        comments: commentsResult.value.value.comments.slice(0, 12),
      }
    : { status: 'unavailable' as const };

  const channel = channelResult[0].status === 'fulfilled'
    ? { status: 'ready' as const, channel: channelResult[0].value.value }
    : { status: 'unavailable' as const };

  return c.json({
    video: videoResult.value.value,
    channel,
    transcript,
    comments,
    quota,
    partial:
      transcript.status !== 'ready' ||
      comments.status !== 'ready' ||
      channel.status !== 'ready',
  });
});

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

function inspectionError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  return new ApiError(503, 'VIDEO_INSPECTION_UNAVAILABLE', 'This video could not be inspected right now.');
}
