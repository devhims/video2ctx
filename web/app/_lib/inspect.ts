/* Shared client for the public landing demo.
 *
 * Extracted so more than one landing direction can use the same request without
 * copying its types. Direction 01 still carries its own copy on purpose — it is
 * frozen as a baseline for the comparison and should not move underneath it.
 */

export interface Thumbnail {
  url: string;
  width?: number;
  height?: number;
}

export interface DemoVideo {
  id: string;
  title: string;
  channel: { id: string; name: string; url: string };
  thumbnails: Thumbnail[];
  durationText?: string;
  viewCountText?: string;
  publishedTimeText?: string;
  url: string;
}

export interface TranscriptSegment {
  startMs: number;
  durationMs: number;
  endMs: number;
  text: string;
}

export interface DemoComment {
  id: string;
  author: { name: string };
  text: string;
  publishedTimeText?: string;
  likeCountText?: string;
  isPinned: boolean;
  isHearted: boolean;
}

export interface DemoResponse {
  video: DemoVideo;
  transcript:
    | {
        status: 'ready';
        track: { name: string; languageCode: string };
        segmentCount: number;
        segments: TranscriptSegment[];
      }
    | { status: 'unavailable' };
  comments:
    | { status: 'ready'; totalCount?: number; comments: DemoComment[] }
    | { status: 'unavailable' };
  quota: { limit: number; remaining: number; resetAt: string; repeated: boolean };
  partial: boolean;
}

const apiBase =
  process.env.NEXT_PUBLIC_PLATFORM_API_BASE_URL ??
  (process.env.NODE_ENV === 'production'
    ? 'https://api.video2ctx.dev'
    : 'http://localhost:8787');

export async function inspect(url: string): Promise<DemoResponse> {
  const response = await fetch(`${apiBase}/v1/demo/youtube/inspect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });

  const payload = (await response.json()) as DemoResponse & {
    error?: { message?: string; details?: { resetAt?: string } };
  };

  if (!response.ok) {
    const reset = payload.error?.details?.resetAt;
    const retry = reset ? ` Try another video after ${formatReset(reset)}.` : '';
    throw new Error(`${payload.error?.message ?? 'That video could not be inspected.'}${retry}`);
  }

  return payload;
}

export function describeError(cause: unknown): string {
  if (cause instanceof TypeError) {
    return 'Could not reach the inspection service. Check your connection and try again.';
  }
  return cause instanceof Error ? cause.message : 'That video could not be inspected.';
}

export function formatTimestamp(milliseconds: number): string {
  const total = Math.floor(milliseconds / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function timestampUrl(videoUrl: string, milliseconds: number): string {
  const separator = videoUrl.includes('?') ? '&' : '?';
  return `${videoUrl}${separator}t=${Math.floor(milliseconds / 1000)}s`;
}

function formatReset(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}
