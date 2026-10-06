import { z } from 'zod';

// Early-access guardrail: the agent works on videos up to a configured length. A multi-hour
// transcript with word timings is several megabytes, and the runtime copies it for every evidence
// read and analysis window, which can exhaust the agent Durable Object's memory.

export const DEFAULT_AGENT_MAX_VIDEO_SECONDS = 7_200;
const MIN_AGENT_MAX_VIDEO_SECONDS = 60;
const MAX_AGENT_MAX_VIDEO_SECONDS = 86_400;

/** Configured limit in seconds. Missing or invalid values use the 2-hour default. */
export function agentMaxVideoSeconds(env: { AGENT_MAX_VIDEO_SECONDS?: string }): number {
  const raw = env.AGENT_MAX_VIDEO_SECONDS?.trim();
  const value = raw ? Number(raw) : NaN;
  if (!Number.isInteger(value)) return DEFAULT_AGENT_MAX_VIDEO_SECONDS;
  return Math.min(MAX_AGENT_MAX_VIDEO_SECONDS, Math.max(MIN_AGENT_MAX_VIDEO_SECONDS, value));
}

/** Human form for messages, such as "2 hours" or "90 minutes". */
export function formatVideoLimit(seconds: number): string {
  if (seconds % 3_600 === 0) return `${seconds / 3_600} hour${seconds === 3_600 ? '' : 's'}`;
  if (seconds % 60 !== 0) return formatVideoDuration(seconds);
  const minutes = seconds / 60;
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

export class VideoTooLongError extends Error {
  override readonly name = 'VideoTooLongError';
  readonly code = 'VIDEO_TOO_LONG';
  constructor(readonly videoId: string, readonly durationSeconds: number, readonly limitSeconds: number) {
    super(`This video is about ${Math.round(durationSeconds / 60)} minutes long. The agent currently supports videos up to ${formatVideoLimit(limitSeconds)}.`);
  }
}

export function videoTooLong(error: unknown): error is { code: 'VIDEO_TOO_LONG' } {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'VIDEO_TOO_LONG';
}

/** Throws when a transcript's last segment ends past the limit. */
export function assertTranscriptWithinLimit(
  videoId: string,
  transcript: { segments: ReadonlyArray<{ endMs?: number }> },
  limitSeconds: number,
): void {
  const endMs = transcript.segments.at(-1)?.endMs;
  if (typeof endMs === 'number' && endMs > limitSeconds * 1_000) throw new VideoTooLongError(videoId, endMs / 1_000, limitSeconds);
}


/** Allowlisted, serializable context; never render a provider's raw error message. */
export const videoDurationFailureSchema = z.object({
  videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/),
  durationSeconds: z.number().finite().positive(),
  limitSeconds: z.number().int().min(MIN_AGENT_MAX_VIDEO_SECONDS).max(MAX_AGENT_MAX_VIDEO_SECONDS),
}).refine(value => value.durationSeconds > value.limitSeconds);
export type VideoDurationFailure = z.infer<typeof videoDurationFailureSchema>;

export function videoDurationFailure(error: unknown): VideoDurationFailure | undefined {
  // Transcript stage errors retain the guardrail error as their cause.
  for (let depth = 0; depth < 4 && error instanceof Error; depth++, error = error.cause) {
    if (error instanceof VideoTooLongError) {
      const parsed = videoDurationFailureSchema.safeParse(error);
      return parsed.success ? parsed.data : undefined;
    }
  }
  return undefined;
}

export function parseVideoDurationFailure(value: string | null): VideoDurationFailure | undefined {
  if (!value) return undefined;
  try {
    const parsed = videoDurationFailureSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : undefined;
  } catch { return undefined; }
}

/** Whole-second precision, without rounding an over-limit duration back to the limit. */
export function formatVideoDuration(seconds: number): string {
  const wholeSeconds = Math.ceil(seconds);
  return [[Math.floor(wholeSeconds / 3600), 'hour'], [Math.floor(wholeSeconds % 3600 / 60), 'minute'], [wholeSeconds % 60, 'second']]
    .filter(([value]) => value !== 0)
    .map(([value, unit]) => `${value} ${unit}${value === 1 ? '' : 's'}`).join(' ');
}
