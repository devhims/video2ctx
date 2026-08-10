import { getContainer } from '@cloudflare/containers';
import type {
  BrowseOptions,
  BrowseResponse,
  CaptionTrackList,
  Channel,
  ChannelPlaylistSort,
  ChannelPlaylists,
  ChannelVideoSort,
  ChannelVideos,
  CommentsCollection,
  CommentsPage,
  EndscreenElement,
  Playlist,
  SearchFilters,
  SearchResponse,
  Transcript,
  Video,
  VideoSignals,
  YouTubeErrorCode,
} from 'all-things-youtube';
import type { YouTubeProcessorContainer } from '../youtube-processor-container';

export type YouTubeOperation =
  | { kind: 'search'; query: string; filters?: SearchFilters }
  | { kind: 'browse'; options?: BrowseOptions }
  | { kind: 'video'; id: string }
  | { kind: 'video-signals'; id: string }
  | { kind: 'channel'; id: string }
  | { kind: 'channel-videos'; id: string; continuation?: string; sort?: ChannelVideoSort }
  | { kind: 'channel-playlists'; id: string; continuation?: string; sort?: ChannelPlaylistSort }
  | { kind: 'playlist'; id: string }
  | { kind: 'comments'; id: string; continuation?: string }
  | { kind: 'all-comments'; id: string; maxPages: number }
  | { kind: 'caption-tracks'; id: string }
  | { kind: 'transcript'; id: string; lang?: string; granularity: 'segment' | 'word' }
  | { kind: 'endscreen'; id: string };

export type YouTubeOperationResult<T extends YouTubeOperation> =
  T extends { kind: 'search' } ? SearchResponse :
  T extends { kind: 'browse' } ? BrowseResponse :
  T extends { kind: 'video' } ? Video :
  T extends { kind: 'video-signals' } ? VideoSignals :
  T extends { kind: 'channel' } ? Channel :
  T extends { kind: 'channel-videos' } ? ChannelVideos :
  T extends { kind: 'channel-playlists' } ? ChannelPlaylists :
  T extends { kind: 'playlist' } ? Playlist :
  T extends { kind: 'comments' } ? CommentsPage :
  T extends { kind: 'all-comments' } ? CommentsCollection :
  T extends { kind: 'caption-tracks' } ? CaptionTrackList :
  T extends { kind: 'transcript' } ? Transcript :
  T extends { kind: 'endscreen' } ? EndscreenElement[] :
  never;

export type ProcessorErrorCode = YouTubeErrorCode
  | 'PROCESSOR_BUSY'
  | 'PROCESSOR_UNAVAILABLE'
  | 'INVALID_PROCESSOR_RESPONSE'
  | 'YOUTUBE_UPSTREAM_ERROR';

interface ProcessorFailure {
  error: {
    code?: string;
    message?: string;
    status?: number;
    retryable?: boolean;
  };
}

const RETRYABLE_CONTAINER_STATUSES = new Set([502, 503, 504]);
const DEFAULT_INSTANCE_COUNT = 2;
const MAX_INSTANCE_COUNT = 4;
const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_RETRY_BASE_MS = 25;

export class YouTubeProcessorError extends Error {
  readonly name = 'YouTubeProcessorError';

  constructor(
    readonly code: ProcessorErrorCode,
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function instanceCount(env: Env): number {
  const parsed = Number(env.YOUTUBE_PROCESSOR_INSTANCE_COUNT);
  if (!Number.isFinite(parsed)) return DEFAULT_INSTANCE_COUNT;
  return Math.max(1, Math.min(MAX_INSTANCE_COUNT, Math.floor(parsed)));
}

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(parsed)));
}

export function randomProcessorSlot(count: number): number {
  const normalizedCount = Math.max(1, Math.min(MAX_INSTANCE_COUNT, Math.floor(count) || 1));
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  return random[0]! % normalizedCount;
}

export function processorSlotOrder(count: number, primary: number): number[] {
  const normalizedCount = Math.max(1, Math.min(MAX_INSTANCE_COUNT, Math.floor(count) || 1));
  const normalizedPrimary = Math.abs(Math.floor(primary) || 0) % normalizedCount;
  return Array.from({ length: normalizedCount }, (_, offset) => (normalizedPrimary + offset) % normalizedCount);
}

function maxAttempts(env: Env, count: number): number {
  return Math.min(count, boundedInteger(env.YOUTUBE_PROCESSOR_MAX_ATTEMPTS, DEFAULT_MAX_ATTEMPTS, 1, MAX_INSTANCE_COUNT));
}

function processorTimeoutMs(env: Env): number {
  return boundedInteger(env.YOUTUBE_PROCESSOR_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 5_000, 300_000);
}

function retryDelayMs(env: Env, attempt: number): number {
  const base = boundedInteger(env.YOUTUBE_PROCESSOR_RETRY_BASE_MS, DEFAULT_RETRY_BASE_MS, 0, 1_000);
  if (base === 0) return 0;
  const ceiling = Math.min(2_000, base * (2 ** attempt));
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  return Math.floor(ceiling / 2) + (random[0]! % (Math.ceil(ceiling / 2) + 1));
}

async function waitBeforeFallback(env: Env, attempt: number): Promise<void> {
  const delayMs = retryDelayMs(env, attempt);
  if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
}

function processorContainer(env: Env, slot: number) {
  const version = env.YOUTUBE_PROCESSOR_VERSION || 'v1';
  return getContainer<YouTubeProcessorContainer>(env.YOUTUBE_PROCESSOR, `${version}-${slot}`);
}

function failureFrom(payload: unknown): ProcessorFailure['error'] | undefined {
  if (!isRecord(payload) || !isRecord(payload.error)) return undefined;
  return payload.error;
}

async function resultFrom<T>(response: Response): Promise<T> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new YouTubeProcessorError(
      'INVALID_PROCESSOR_RESPONSE',
      'The YouTube processor returned invalid JSON.',
      response.status,
      response.status >= 500,
    );
  }

  if (!response.ok) {
    const failure = failureFrom(payload);
    throw new YouTubeProcessorError(
      typeof failure?.code === 'string' ? failure.code as ProcessorErrorCode : 'PROCESSOR_UNAVAILABLE',
      typeof failure?.message === 'string' ? failure.message : 'The YouTube processor is unavailable.',
      typeof failure?.status === 'number' ? failure.status : response.status,
      typeof failure?.retryable === 'boolean' ? failure.retryable : response.status >= 500,
    );
  }

  if (!isRecord(payload) || !('value' in payload)) {
    throw new YouTubeProcessorError(
      'INVALID_PROCESSOR_RESPONSE',
      'The YouTube processor response did not include a value.',
      response.status,
    );
  }

  return payload.value as T;
}

export async function runYouTubeOperation<T extends YouTubeOperation>(
  env: Env,
  operation: T,
): Promise<YouTubeOperationResult<T>> {
  const body = JSON.stringify(operation);
  const count = instanceCount(env);
  const slots = processorSlotOrder(count, randomProcessorSlot(count)).slice(0, maxAttempts(env, count));
  let lastFailure: unknown;

  for (let index = 0; index < slots.length; index += 1) {
    const slot = slots[index]!;
    const startedAt = Date.now();
    try {
      const response = await processorContainer(env, slot).fetch(new Request('http://youtube-processor/operations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(processorTimeoutMs(env)),
      }));

      const hasFallback = index < slots.length - 1;
      if (hasFallback && RETRYABLE_CONTAINER_STATUSES.has(response.status)) {
        logProcessorAttempt(operation.kind, slot, index, response.status, 'fallback', startedAt);
        if (response.body) await response.body.cancel().catch(() => undefined);
        await waitBeforeFallback(env, index);
        continue;
      }

      const result = await resultFrom<YouTubeOperationResult<T>>(response);
      logProcessorAttempt(operation.kind, slot, index, response.status, 'success', startedAt);
      return result;
    } catch (error) {
      if (error instanceof YouTubeProcessorError) {
        logProcessorAttempt(operation.kind, slot, index, error.status, 'processor-error', startedAt);
        throw error;
      }
      lastFailure = error;
      logProcessorAttempt(operation.kind, slot, index, undefined, 'transport-error', startedAt);
      if (index === slots.length - 1) break;
      await waitBeforeFallback(env, index);
    }
  }

  if (lastFailure instanceof YouTubeProcessorError) throw lastFailure;
  throw new YouTubeProcessorError(
    'PROCESSOR_UNAVAILABLE',
    lastFailure instanceof Error ? lastFailure.message : 'The YouTube processor is unavailable.',
    503,
    true,
  );
}

function logProcessorAttempt(
  operation: YouTubeOperation['kind'],
  slot: number,
  attempt: number,
  status: number | undefined,
  outcome: 'success' | 'fallback' | 'processor-error' | 'transport-error',
  startedAt: number,
): void {
  const payload = JSON.stringify({
    event: 'youtube_processor_attempt',
    operation,
    slot,
    attempt: attempt + 1,
    status,
    outcome,
    durationMs: Date.now() - startedAt,
  });
  if (outcome === 'success') console.log(payload);
  else console.warn(payload);
}
