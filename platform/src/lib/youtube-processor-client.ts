import { abortableContainerFetch, boundedContainerJson } from './bounded-container-json';
import { extractionCapture, extractionFailureKind, emitExtractionDiagnostic, type ExtractionAttempt, type ExtractionDiagnosticSink } from './extraction-diagnostics';
import type { Storyboard } from '../agents/providers/youtube/storyboard';
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
import { isVideoMetadataBotChallenge } from './youtube-metadata';

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
  | { kind: 'storyboard'; id: string; timestampsMs?: number[]; maxSheets?: number; sheetIndexes?: number[]; metadataOnly?: boolean }
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
  T extends { kind: 'storyboard' } ? Storyboard :
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

const DEFAULT_INSTANCE_COUNT = 2;
const MAX_INSTANCE_COUNT = 4;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_RETRY_BASE_MS = 250;

export class YouTubeProcessorError extends Error {
  readonly name = 'YouTubeProcessorError';

  constructor(
    readonly code: ProcessorErrorCode,
    message: string,
    readonly status?: number,
    readonly retryable = false,
    readonly retryAfterMs = 0,
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

function maxAttempts(env: Env): number {
  return boundedInteger(env.YOUTUBE_PROCESSOR_MAX_ATTEMPTS, DEFAULT_MAX_ATTEMPTS, 1, MAX_INSTANCE_COUNT);
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

function retryAfterMs(response: Response): number {
  const value = response.headers.get('retry-after');
  if (!value) return 0;
  const seconds = Number(value);
  return Math.max(0, Number.isFinite(seconds) ? seconds * 1000 : (Date.parse(value) || 0) - Date.now());
}

async function waitBeforeFallback(delayMs: number, deadline: AbortSignal): Promise<void> {
  deadline.throwIfAborted();
  if (delayMs <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); reject(deadline.reason); };
    const timer = setTimeout(() => { deadline.removeEventListener('abort', cancel); resolve(); }, Math.min(delayMs, 2_147_483_647));
    deadline.addEventListener('abort', cancel, { once: true });
  });
}

// Bounded, best-effort routing hints within this isolate. No request payloads or
// I/O handles are retained, and correctness never depends on this cache existing.
const processorHealth = new WeakMap<Env, Map<number, number>>();
function healthFor(env: Env): Map<number, number> {
  let health = processorHealth.get(env);
  if (!health) { health = new Map(); processorHealth.set(env, health); }
  return health;
}

function processorContainer(env: Env, slot: number) {
  const version = env.YOUTUBE_PROCESSOR_VERSION || 'v1';
  return getContainer<YouTubeProcessorContainer>(env.YOUTUBE_PROCESSOR, `${version}-${slot}`);
}

function failureFrom(payload: unknown): ProcessorFailure['error'] | undefined {
  if (!isRecord(payload) || !isRecord(payload.error)) return undefined;
  return payload.error;
}

function shouldFallbackResult(operation: YouTubeOperation, result: unknown): boolean {
  if (operation.kind !== 'caption-tracks' || !isRecord(result)) return false;
  const metadata = result.meta;
  return Array.isArray(result.tracks)
    && result.tracks.length === 0
    && isRecord(metadata)
    && metadata.partial === true;
}

function shouldFallbackError(operation: YouTubeOperation, error: YouTubeProcessorError): boolean {
  // A transcript NOT_FOUND can mean that one YouTube response omitted its
  // caption catalog. Try an independent processor slot before treating it as
  // a genuine captionless video.
  return error.retryable || (operation.kind === 'transcript' && error.code === 'NOT_FOUND');
}

async function resultFrom<T>(response: Response, signal?: AbortSignal, onPayload?: (payload: unknown) => void): Promise<T> {
  let payload: unknown;
  try {
    payload = signal ? await boundedContainerJson(response, signal) : await response.json();
    onPayload?.(payload);
  } catch {
    signal?.throwIfAborted();
    throw new YouTubeProcessorError(
      'INVALID_PROCESSOR_RESPONSE',
      'The YouTube processor returned invalid JSON.',
      response.status,
      response.status === 429 || response.status >= 500,
      retryAfterMs(response),
    );
  }

  if (!response.ok) {
    const failure = failureFrom(payload);
    throw new YouTubeProcessorError(
      typeof failure?.code === 'string' ? failure.code as ProcessorErrorCode : 'PROCESSOR_UNAVAILABLE',
      typeof failure?.message === 'string' ? failure.message : 'The YouTube processor is unavailable.',
      typeof failure?.status === 'number' ? failure.status : response.status,
      typeof failure?.retryable === 'boolean' ? failure.retryable : response.status === 429 || response.status >= 500,
      retryAfterMs(response),
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
  env: Env, operation: T, onDiagnostic?: ExtractionDiagnosticSink,
): Promise<YouTubeOperationResult<T>> {
  const body = JSON.stringify(operation);
  const extractionId = crypto.randomUUID();
  const operationStartedAt = Date.now();
  const count = instanceCount(env);
  const health = healthFor(env);
  const order = processorSlotOrder(count, randomProcessorSlot(count));
  // Stable sort preserves random order among equally healthy processors.
  order.sort((a, b) => Number((health.get(a) ?? 0) > operationStartedAt) - Number((health.get(b) ?? 0) > operationStartedAt));
  const attempts = maxAttempts(env);
  const deadline = AbortSignal.timeout(processorTimeoutMs(env));
  const missingTranscriptSlots = new Set<number>();
  let lastFailure: unknown;
  for (let index = 0; index < attempts; index += 1) {
    // Probe every slot before repeating, then revisit only inconclusive slots.
    const repeatSlots = order.filter(slot => !missingTranscriptSlots.has(slot));
    const slot = index < order.length ? order[index]!
      : repeatSlots[(index - order.length) % repeatSlots.length]!;
    const startedAt = Date.now();
    let outcome: ExtractionAttempt['outcome'] = 'transport_error';
    let capture: Pick<ExtractionAttempt, 'capture' | 'events' | 'droppedEvents'> = { capture: 'unavailable', events: [], droppedEvents: 0 };
    let status: number | undefined;
    let failureKind: ExtractionAttempt['failureKind'];
    let reason: 'YOUTUBE_BOT_CHALLENGE' | undefined;
    let delay = 0;
    let retry = false;
    try {
      deadline.throwIfAborted();
      const response = await abortableContainerFetch(deadline, () => processorContainer(env, slot).fetch(new Request('http://youtube-processor/operations', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-extraction-id': extractionId }, body, signal: deadline,
      })));
      status = response.status;
      outcome = 'failed';
      const result = await resultFrom<YouTubeOperationResult<T>>(response, deadline, payload => { capture = extractionCapture(payload); });
      if (operation.kind === 'video' && isVideoMetadataBotChallenge(result)) {
        reason = 'YOUTUBE_BOT_CHALLENGE';
        throw new YouTubeProcessorError('UNAVAILABLE', 'YouTube blocked the metadata lookup with a bot challenge. The video may still be available.', 503, true);
      }
      // Empty partial catalogs get one pass across the slots, not extra cycles.
      if (index + 1 < Math.min(count, attempts) && shouldFallbackResult(operation, result)) {
        outcome = 'fallback'; retry = true; delay = retryDelayMs(env, index);
      } else {
        health.delete(slot);
        outcome = 'success';
        logProcessorAttempt(operation.kind, slot, index, status, 'success', startedAt, undefined, extractionId, operationStartedAt);
        return result;
      }
    } catch (error) {
      lastFailure = error;
      failureKind = extractionFailureKind(error, deadline);
      const classified = error instanceof YouTubeProcessorError;
      if (classified) status = error.status;
      if (classified && operation.kind === 'transcript' && error.code === 'NOT_FOUND' && !error.retryable)
        missingTranscriptSlots.add(slot);
      // Missing captions are conclusive only after every slot agrees. A prior
      // transient failure must retain its opportunity to recover on a repeat.
      const canRetry = !classified || (shouldFallbackError(operation, error)
        && (error.retryable || missingTranscriptSlots.size < count));
      retry = !deadline.aborted && index + 1 < attempts && canRetry;
      if (canRetry && !deadline.aborted) health.set(slot, Date.now() + 30_000);
      outcome = retry ? 'fallback' : classified ? 'failed' : 'transport_error';
      delay = Math.max(retryDelayMs(env, index), classified ? error.retryAfterMs : 0);
      if (!retry && classified && !deadline.aborted) throw error;
    } finally {
      if (outcome !== 'success') logProcessorAttempt(operation.kind, slot, index, status,
        outcome === 'fallback' ? 'fallback' : outcome === 'transport_error' ? 'transport-error' : 'processor-error',
        startedAt, reason, extractionId, operationStartedAt, failureKind);
      if (operation.kind === 'storyboard' || operation.kind === 'transcript') emitExtractionDiagnostic(onDiagnostic, {
        version: 1, kind: operation.kind, videoId: operation.id, extractionId, attempt: index + 1, slot,
        recordedAt: Date.now(), elapsedMs: Date.now() - startedAt, status,
        outcome, failureKind, ...capture,
      });
    }
    if (!retry) break;
    try { await waitBeforeFallback(delay, deadline); }
    catch (error) { lastFailure = error; break; }
  }
  throw new YouTubeProcessorError('PROCESSOR_UNAVAILABLE',
    deadline.aborted ? 'The YouTube operation exceeded the API deadline. Please try again.'
      : lastFailure instanceof Error ? lastFailure.message : 'The YouTube processor is unavailable.', 503, true);
}

function logProcessorAttempt(
  operation: YouTubeOperation['kind'],
  slot: number,
  attempt: number,
  status: number | undefined,
  outcome: 'success' | 'fallback' | 'processor-error' | 'transport-error',
  startedAt: number,
  reason?: 'YOUTUBE_BOT_CHALLENGE',
  extractionId?: string, operationStartedAt = startedAt, failureKind?: ExtractionAttempt['failureKind'],
): void {
  const payload = JSON.stringify({
    event: 'youtube_processor_attempt',
    extractionId, totalElapsedMs: Date.now() - operationStartedAt, failureKind,
    operation,
    slot,
    attempt: attempt + 1,
    status,
    outcome,
    ...(reason ? { reason } : {}),
    durationMs: Date.now() - startedAt,
  });
  if (outcome === 'success') console.log(payload);
  else console.warn(payload);
}
