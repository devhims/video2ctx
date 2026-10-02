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
  const minutes = Math.round(seconds / 60);
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
