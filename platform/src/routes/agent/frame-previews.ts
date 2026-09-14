import { Hono } from 'hono';
import { framePreviewKey, framePreviewSchema } from '../../agents/runtime/frame-previews';
import { ApiError } from '../../lib/http';
import type { App } from '../../types';

// Public image links only. Session reads and frame extraction remain authenticated.
export const agentFramePreviewRoutes = new Hono<App>();
agentFramePreviewRoutes.get('/agent/frames/:collectionId/:assetId', async c => {
  c.header('Cache-Control', 'no-store');
  const parsed = framePreviewSchema.pick({ collectionId: true, assetId: true }).safeParse(c.req.param());
  if (!parsed.success) throw new ApiError(422, 'INVALID_FRAME_PREVIEW_PATH', 'Invalid frame preview identifier.');
  const object = await c.env.RESEARCH.get(framePreviewKey(parsed.data.collectionId, parsed.data.assetId));
  if (!object) throw new ApiError(404, 'FRAME_PREVIEW_NOT_FOUND', 'This frame preview is unavailable.');
  c.header('Content-Type', 'image/jpeg');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Robots-Tag', 'noindex, nofollow');
  c.header('Content-Disposition', 'inline; filename="video-frame.jpg"');
  return c.body(object.body);
});
