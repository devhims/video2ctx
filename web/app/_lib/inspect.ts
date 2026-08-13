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
  description?: string;
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
  author: { id?: string; name: string; thumbnails?: Thumbnail[] };
  text: string;
  publishedTimeText?: string;
  likeCount?: number;
  likeCountText?: string;
  replyCount?: number;
  isPinned: boolean;
  isHearted: boolean;
}

export interface DemoChannel {
  id: string;
  name: string;
  handle?: string;
  thumbnails: Thumbnail[];
  url: string;
  about: {
    description?: string;
    links: { title: string; displayUrl: string; url: string }[];
    moreInfo: {
      joinedDate?: string;
      joinedDateText?: string;
      subscriberCount?: number;
      subscriberCountText?: string;
      videoCount?: number;
      videoCountText?: string;
      viewCount?: number;
      viewCountText?: string;
      businessEmailAvailable: boolean;
    };
  };
}

export interface DemoResponse {
  video: DemoVideo;
  channel?:
    | { status: 'ready'; channel: DemoChannel }
    | { status: 'unavailable'; debugReason?: string };
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

export class InspectionRequestError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(
    status: number,
    code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'InspectionRequestError';
    this.status = status;
    this.code = code;
  }
}

export async function inspect(url: string): Promise<DemoResponse> {
  const response = await fetch('/api/platform/v1/demo/youtube/inspect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });

  const payload = (await response.json()) as DemoResponse & {
    error?: { code?: string; message?: string; details?: { resetAt?: string } };
  };

  if (!response.ok) {
    const reset = payload.error?.details?.resetAt;
    const retry = reset ? ` Try another video after ${formatReset(reset)}.` : '';
    throw new InspectionRequestError(
      response.status,
      payload.error?.code,
      `${payload.error?.message ?? 'That video could not be inspected.'}${retry}`,
    );
  }

  return payload;
}

export function isLandingDemoLimitError(cause: unknown): boolean {
  return cause instanceof InspectionRequestError
    && cause.status === 429
    && cause.code === 'LANDING_DEMO_LIMIT_REACHED';
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

export function transcriptExcerptText(segments: TranscriptSegment[]): string {
  return segments
    .map((segment) => `[${formatTimestamp(segment.startMs)}] ${segment.text}`)
    .join('\n');
}

function formatReset(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}
