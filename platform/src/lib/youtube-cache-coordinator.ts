import { captureVisualWork, withVisualFailureCapture, visualSpan, countVisualWork, type VisualDiagnostics, type VisualFailureCapture } from './visual-diagnostics';
import { emitExtractionDiagnostic, type ExtractionAttempt, type ExtractionDiagnosticSink } from './extraction-diagnostics';
import { YouTubeProcessorError, youtubeOperationTimeoutMs } from './youtube-processor-client';
import { ApiError, safeErrorLog } from './http';
import { isVideoMetadataBotChallenge } from './youtube-metadata';
import { storyboardMetadata, storyboardSchema } from '../agents/providers/youtube/storyboard';
import { videoCatalog, VideoCatalogWriteError, type VideoAssetReference } from './video-catalog';
import { isVisualSelection, readFrameSelection, readStoryboardSelection, type VisualLookup, loadVideoResource, readVideoResource, reusableVideoResource, saveVideoResource, resourceComplete, videoResourceKey, type VideoResourceOperation } from './video-resources';

export type CacheStatus = 'hit' | 'miss' | 'coalesced' | 'stale';

export interface YouTubeCacheEntry<T = unknown> {
  catalogVersions?: VideoAssetReference[];
  version: 1;
  value: T;
  fetchedAt: number;
  freshUntil: number;
}

export interface YouTubeCacheRequest {
  cacheKey: string;
  legacyCacheKey?: string;
  resourceType: string;
  maxAgeMs: number;
  operation: VideoResourceOperation;
  refresh?: boolean;
}

export interface YouTubeCacheResponse {
  visualDiagnostics?: VisualDiagnostics;
  catalogVersions?: VideoAssetReference[];
  diagnostics?: ExtractionAttempt[];
  ok: boolean;
  value?: unknown;
  fetchedAt?: number;
  cacheStatus?: CacheStatus;
  error?: {
    code: string;
    apiStatus?: ApiError['status'];
    message: string;
    status?: number;
    retryable: boolean;
    reason?: 'bot_challenge';
  };
}

type OperationLoader = (env: Env, operation: VideoResourceOperation, onDiagnostic?: ExtractionDiagnosticSink, refresh?: boolean, onVersions?: (references: VideoAssetReference[]) => void, visualLookup?: VisualLookup) => Promise<unknown>;

const CACHE_READ_TTL_SECONDS = 60;
const MINIMUM_CACHE_RETENTION_MS = 7 * 24 * 60 * 60_000;

interface RecentResult {
  cacheKey: string;
  entry: YouTubeCacheEntry;
}

interface ExtractionFlight {
  deadlineAt?: number;
  effectiveDeadlineAt: number;
  promise: Promise<YouTubeCacheResponse>;
}

// Stop only this waiter. The shared extraction can still serve other callers.
async function waitForExtraction(promise: Promise<YouTubeCacheResponse>, deadlineAt?: number): Promise<YouTubeCacheResponse> {
  if (deadlineAt === undefined) return promise;
  const expired = () => failureFrom(new ApiError(503, 'EXTRACTION_DEADLINE_EXCEEDED', 'The extraction deadline expired.'));
  if (deadlineAt <= Date.now()) return expired();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<YouTubeCacheResponse>(resolve => {
      timer = setTimeout(() => resolve(expired()), deadlineAt - Date.now());
    })]);
  } finally { clearTimeout(timer); }
}

export class YouTubeCacheCoordinatorCore {
  private readonly inFlight = new Map<string, Set<ExtractionFlight>>();
  private recent?: RecentResult;

  constructor(
    private readonly env: Env,
    private readonly loadOperation: OperationLoader = loadVideoResource,
  ) {}

  async getOrLoad(request: YouTubeCacheRequest): Promise<YouTubeCacheResponse> {
    const deadlineAt = 'deadlineAt' in request.operation ? request.operation.deadlineAt : undefined;
    const effectiveDeadlineAt = deadlineAt ?? (request.operation.kind === 'frames' ? Infinity
      : Date.now() + youtubeOperationTimeoutMs(this.env, request.operation));
    const flightKey = `${request.cacheKey}:${!!request.refresh}`;
    const flights = this.inFlight.get(flightKey);
    // Deadline-free callers retain their existing coalescing policy. Explicit
    // deadlines can share only when the leader has at least that much time.
    const active = [...(flights ?? [])].find(flight => flight.effectiveDeadlineAt > Date.now()
      && ((deadlineAt === undefined && flight.deadlineAt === undefined)
        || flight.effectiveDeadlineAt >= effectiveDeadlineAt));
    if (active) {
      const shared = await waitForExtraction(active.promise, deadlineAt
        ?? (active.deadlineAt === undefined ? undefined : effectiveDeadlineAt));
      return shared.ok && shared.cacheStatus === 'miss'
        ? { ...shared, cacheStatus: 'coalesced' }
        : shared;
    }
    if (deadlineAt !== undefined && deadlineAt <= Date.now())
      return failureFrom(new ApiError(503, 'EXTRACTION_DEADLINE_EXCEEDED', 'The extraction deadline expired.'));

    const recent = this.recent;
    if (!request.refresh && !videoCatalog(this.env) && recent?.cacheKey === request.cacheKey && recent.entry.freshUntil > Date.now()) {
      return successFromEntry(recent.entry, 'hit');
    }

    const promise = this.loadAndRemember(request);
    const flight = { deadlineAt, effectiveDeadlineAt, promise };
    const group = flights ?? new Set<ExtractionFlight>();
    group.add(flight);
    this.inFlight.set(flightKey, group);
    const remove = () => {
      group.delete(flight);
      if (!group.size && this.inFlight.get(flightKey) === group) this.inFlight.delete(flightKey);
    };
    void promise.then(remove, remove);
    return waitForExtraction(promise, deadlineAt);
  }

  private async loadAndRemember(request: YouTubeCacheRequest): Promise<YouTubeCacheResponse> {
    const response = await this.loadDiagnosed(request);
    if (
      !videoCatalog(this.env)
      && response.ok
      && response.cacheStatus !== 'stale'
      && response.value !== undefined
      && response.fetchedAt !== undefined
      && resourceComplete(request.operation, response.value)
    ) {
      this.recent = {
        cacheKey: request.cacheKey,
        entry: {
          version: 1,
          value: response.value,
          fetchedAt: response.fetchedAt,
          freshUntil: response.fetchedAt + request.maxAgeMs,
        },
      };
    }
    return response;
  }

  private async loadDiagnosed(request: YouTubeCacheRequest): Promise<YouTubeCacheResponse> {
    const kind = request.operation.kind;
    if (kind !== 'frames' && kind !== 'storyboard') return this.load(request);
    const failure: VisualFailureCapture = {};
    try {
      const { value, diagnostics } = await withVisualFailureCapture(failure,
        () => captureVisualWork('coordinator', kind, () => this.load(request)));
      if (!value.ok) diagnostics.outcome = 'error';
      return { ...value, visualDiagnostics: diagnostics };
    } catch (error) {
      return { ...failureFrom(error), visualDiagnostics: failure.diagnostics };
    }
  }

  private async load(request: YouTubeCacheRequest): Promise<YouTubeCacheResponse> {
    const catalog = videoCatalog(this.env);
    const resource = videoResourceKey(request.operation);
    const selection = catalog && isVisualSelection(request.operation)
      ? request.operation : undefined;
    const lookup = selection && !request.refresh
      ? selection.kind === 'frames' ? await readFrameSelection(this.env, selection) : await readStoryboardSelection(this.env, selection) : undefined;
    const stored = lookup ? lookup.stored : selection ? null
      : catalog && resource ? await readVideoResource(this.env,request.operation) : null;
    const existing = stored ? {version:1 as const,...stored} : await readYouTubeCacheEntry(this.env, request.legacyCacheKey ?? request.cacheKey, request.resourceType);
    const timestamp = Date.now();
    if (!request.refresh && existing && reusableVideoResource(request.operation, existing, timestamp)) {
      // Promote pre-catalog KV hits without pretending they were freshly fetched.
      if (catalog && resource && !stored) {
        const metadataVersions = selection?.kind === 'storyboard' ? await saveVideoResource(this.env,
          {kind: 'storyboard', id: selection.id, metadataOnly: true},
          storyboardMetadata(storyboardSchema.parse(existing.value)), existing.fetchedAt, request.maxAgeMs) : [];
        existing.catalogVersions = [...metadataVersions,
          ...await saveVideoResource(this.env,request.operation,existing.value,existing.fetchedAt,request.maxAgeMs)];
      }
      return successFromEntry(existing, 'hit');
    }

    const diagnostics: ExtractionAttempt[] = [];
    const onDiagnostic: ExtractionDiagnosticSink = event => {
      if (['transcript','storyboard','frames'].includes(request.operation.kind) && diagnostics.length < (request.operation.kind === 'frames' ? 4 : 5)) {
        emitExtractionDiagnostic(item => { diagnostics.push(item); }, event);
      }
    };
    const withDiagnostics = (response: YouTubeCacheResponse): YouTubeCacheResponse =>
      diagnostics.length ? { ...response, diagnostics } : response;
    try {
      let catalogVersions: VideoAssetReference[] | undefined;
      const value = await this.loadOperation(this.env, request.operation, onDiagnostic, request.refresh, versions=>{catalogVersions=versions;}, lookup);
      // Defense in depth: a resolved provider response can still be a failed
      // lookup. Preserve the last good value instead of overwriting it.
      if (request.operation.kind === 'video' && isVideoMetadataBotChallenge(value)) {
        throw new YouTubeProcessorError('UNAVAILABLE',
          'YouTube blocked the metadata lookup with a bot challenge.', 503, true);
      }
      const complete = !resource || resourceComplete(request.operation,value);
      const entry: YouTubeCacheEntry = {
        version: 1,
        catalogVersions,
        value,
        fetchedAt: timestamp,
        freshUntil: complete ? timestamp + request.maxAgeMs : timestamp,
      };
      if (catalog && resource) {
        // The visual loader saves just the fresh misses, preserving hit timestamps.
        if (request.operation.kind !== 'frames' && (request.operation.kind !== 'storyboard' || request.operation.metadataOnly))
          entry.catalogVersions = await saveVideoResource(this.env,request.operation,value,timestamp,request.maxAgeMs);
        return withDiagnostics(successFromEntry(entry,'miss'));
      }
      try {
        countVisualWork('legacyKvPuts');
        await visualSpan('legacy_cache', () => this.env.YOUTUBE_CACHE.put(request.cacheKey, JSON.stringify(entry), {
          expirationTtl: cacheRetentionSeconds(request.maxAgeMs),
        }));
      } catch (error) {
        logCacheFailure('youtube_cache_write_failed', request.resourceType, error);
      }
      return withDiagnostics(successFromEntry(entry, 'miss'));
    } catch (error) {
      if (error instanceof VideoCatalogWriteError) {
        logCacheFailure('video_catalog_write_failed',request.resourceType,error.cause);
        return withDiagnostics(failureFrom(new ApiError(503, 'VIDEO_CATALOG_UNAVAILABLE', error.message)));
      }
      if (existing && !request.refresh) return withDiagnostics(successFromEntry(existing, 'stale'));
      return withDiagnostics(failureFrom(error));
    }
  }
}

export async function readYouTubeCacheEntry<T>(
  env: Env,
  cacheKey: string,
  resourceType: string,
): Promise<YouTubeCacheEntry<T> | null> {
  try {
    countVisualWork('legacyKvGets');
    const value = await visualSpan('legacy_cache', () => env.YOUTUBE_CACHE.get<YouTubeCacheEntry<T>>(cacheKey, {
      type: 'json',
      cacheTtl: CACHE_READ_TTL_SECONDS,
    }));
    if (!isCacheEntry<T>(value)) return null;
    // Also invalidate bot challenges written by older deployments. Both the
    // edge cache fast path and the coordinator use this reader.
    if (resourceType === 'video' && isVideoMetadataBotChallenge(value.value)) return null;
    return value;
  } catch (error) {
    logCacheFailure('youtube_cache_read_failed', resourceType, error);
    return null;
  }
}

export function cacheRetentionSeconds(maxAgeMs: number): number {
  return Math.ceil(Math.max(maxAgeMs * 2, MINIMUM_CACHE_RETENTION_MS) / 1000);
}

function successFromEntry(entry: YouTubeCacheEntry, cacheStatus: CacheStatus): YouTubeCacheResponse {
  return {
    ok: true,
    catalogVersions: entry.catalogVersions,
    value: entry.value,
    fetchedAt: entry.fetchedAt,
    cacheStatus,
  };
}

function failureFrom(error: unknown): YouTubeCacheResponse {
  if (error instanceof ApiError) return {ok:false,error:{code:error.code,message:error.message,apiStatus:error.status,status:error.status,retryable:error.status>=500}};
  if (error instanceof YouTubeProcessorError) {
    return {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        status: error.status,
        retryable: error.retryable,
        ...(error.reason === 'bot_challenge' ? { reason: error.reason } : {}),
      },
    };
  }
  return {
    ok: false,
    error: {
      code: 'YOUTUBE_UPSTREAM_ERROR',
      message: error instanceof Error ? error.message : 'YouTube is unavailable.',
      status: 502,
      retryable: true,
    },
  };
}

function isCacheEntry<T>(value: unknown): value is YouTubeCacheEntry<T> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.version === 1
    && 'value' in record
    && Number.isFinite(record.fetchedAt)
    && Number.isFinite(record.freshUntil);
}

function logCacheFailure(event: string, resourceType: string, error: unknown): void {
  console.warn({ event, resourceType, ...safeErrorLog(error) });
}
