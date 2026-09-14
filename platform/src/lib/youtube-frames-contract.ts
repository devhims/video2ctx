import { z } from 'zod';

const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const frameRequestSchema = z.object({
  videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/),
  timestampsMs: z.array(timestamp).min(1).max(6)
    .describe('Requested seek positions in milliseconds, strictly before video duration.'),
  maxWidth: z.number().int().min(320).max(1920).default(1920),
}).strict();

export const framesSchema = z.object({
  videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/),
  frames: z.array(z.object({
    timestampMs: timestamp,
    mimeType: z.literal('image/jpeg'),
    width: z.number().int().positive().max(1920),
    height: z.number().int().positive().max(16384),
    sourceWidth: z.number().int().positive().optional(),
    sourceHeight: z.number().int().positive().optional(),
    imageBase64: z.string().min(4).max(5_592_408).regex(/^\/9j\/[A-Za-z0-9+/]*={0,2}$/),
  })).min(1).max(6),
  failures: z.array(z.object({ timestampMs: timestamp, code: z.string().max(100),
    message: z.string().max(1000), retryable: z.boolean() })).max(6),
  meta: z.object({ partial: z.boolean(), warnings: z.array(z.string().max(1000)).max(20),
    fetchedAt: z.string().optional(), source: z.string().optional() }),
}).superRefine((result, ctx) => {
  const times = [...result.frames, ...result.failures].map(frame => frame.timestampMs);
  if (new Set(times).size !== times.length || times.length > 6
    || result.meta.partial !== (result.failures.length > 0)
    || result.frames.reduce((sum, frame) => sum + frame.imageBase64.length, 0) > 11_184_816) {
    ctx.addIssue({ code: 'custom', message: 'Invalid frame coverage or image budget.' });
  }
});
export type VideoFrames = z.infer<typeof framesSchema>;

export function validateFrameResponse(input: z.infer<typeof frameRequestSchema>, value: unknown): VideoFrames {
  const parsed = framesSchema.parse(value);
  const expected = new Set(input.timestampsMs);
  const supplied = [...parsed.frames, ...parsed.failures];
  if (parsed.videoId !== input.videoId || supplied.length !== expected.size
    || supplied.some(frame => !expected.has(frame.timestampMs))
    || parsed.frames.some(frame => frame.width > input.maxWidth)) {
    throw new Error('Frame response does not match the requested video, timestamps, or dimensions.');
  }
  return parsed;
}
