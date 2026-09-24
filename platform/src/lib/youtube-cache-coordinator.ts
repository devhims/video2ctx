import { emitExtractionDiagnostic, type ExtractionAttempt, type ExtractionDiagnosticSink } from './extraction-diagnostics';
import { YouTubeProcessorError } from './youtube-processor-client';
import { ApiError, safeErrorLog } from './http';
import { isVideoMetadataBotChallenge } from './youtube-metadata';
import { videoCatalog, VideoCatalogWriteError } from './video-catalog';
import { loadVideoResource, readVideoResource, saveVideoResource, resourceComplete, videoResourceKey, type VideoResourceOperation } from './video-resources';

export type CacheStatus = 'hit' | 'miss' | 'coalesced' | 'stale';

export interface YouTubeCacheEntry<T = unknown> {
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
  };
}

type OperationLoader = (env: Env, operation: VideoResourceOperation, onDiagnostic?: ExtractionDiagnosticSink, refresh?: boolean) => Promise<unknown>;

const CACHE_READ_TTL_SECONDS = 60;
const MINIMUM_CACHE_RETENTION_MS = 7 * 24 * 60 * 60_000;

interface RecentResult {
  cacheKey: string;
  entry: YouTubeCacheEntry;
}

export class YouTubeCacheCoordinatorCore {
  private readonly inFlight = new Map<string, Promise<YouTubeCacheResponse>>();
  private recent?: RecentResult;

  constructor(
    private readonly env: Env,
    private readonly loadOperation: OperationLoader = loadVideoResource,
  ) {}

  async getOrLoad(request: YouTubeCacheRequest): Promise<YouTubeCacheResponse> {
    const flightKey = `${request.cacheKey}:${!!request.refresh}`;
    const active = this.inFlight.get(flightKey);
    if (active) {
      const shared = await active;
      return shared.ok && shared.cacheStatus === 'miss'
        ? { ...shared, cacheStatus: 'coalesced' }
        : shared;
    }

    const recent = this.recent;
    if (!request.refresh && !videoCatalog(this.env) && recent?.cacheKey === request.cacheKey && recent.entry.freshUntil > Date.now()) {
      return successFromEntry(recent.entry, 'hit');
    }

    const promise = this.load(request);
    this.inFlight.set(flightKey,promise);
    try {
      const response = await promise;
      if (
        !videoCatalog(this.env)
        && response.ok
        && response.cacheStatus !== 'stale'
        && response.value !== undefined
        && response.fetchedAt !== undefined
        && resourceComplete(request.operation,response.value)
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
    } finally {
      if (this.inFlight.get(flightKey) === promise) this.inFlight.delete(flightKey);
    }
  }

  private async load(request: YouTubeCacheRequest): Promise<YouTubeCacheResponse> {
    const catalog = videoCatalog(this.env);
    const resource = videoResourceKey(request.operation);
    const stored = catalog && resource ? await readVideoResource(this.env,request.operation) : null;
    const existing = stored ? {version:1 as const,...stored} : await readYouTubeCacheEntry(this.env, request.legacyCacheKey ?? request.cacheKey, request.resourceType);
    const timestamp = Date.now();
    if (!request.refresh && existing && existing.freshUntil > timestamp && (!resource || resourceComplete(request.operation,existing.value))) {
      // Promote pre-catalog KV hits without pretending they were freshly fetched.
      if (catalog && resource && !stored) await saveVideoResource(this.env,request.operation,existing.value,existing.fetchedAt,request.maxAgeMs);
      return successFromEntry(existing, 'hit');
    }

    const diagnostics: ExtractionAttempt[] = [];
    const onDiagnostic: ExtractionDiagnosticSink = event => {
      if (['transcript','storyboard','frames'].includes(request.operation.kind) && diagnostics.length < 4) {
        emitExtractionDiagnostic(item => { diagnostics.push(item); }, event);
      }
    };
    const withDiagnostics = (response: YouTubeCacheResponse): YouTubeCacheResponse =>
      diagnostics.length ? { ...response, diagnostics } : response;
    try {
      const value = await this.loadOperation(this.env, request.operation, onDiagnostic, request.refresh);
      // Defense in depth: a resolved provider response can still be a failed
      // lookup. Preserve the last good value instead of overwriting it.
      if (request.operation.kind === 'video' && isVideoMetadataBotChallenge(value)) {
        throw new YouTubeProcessorError('UNAVAILABLE',
          'YouTube blocked the metadata lookup with a bot challenge.', 503, true);
      }
      const complete = !resource || resourceComplete(request.operation,value);
      const entry: YouTubeCacheEntry = {
        version: 1,
        value,
        fetchedAt: timestamp,
        freshUntil: complete ? timestamp + request.maxAgeMs : timestamp,
      };
      if (catalog && resource) {
        // The visual loader saves just the fresh misses, preserving hit timestamps.
        if (request.operation.kind !== 'frames' && (request.operation.kind !== 'storyboard' || request.operation.metadataOnly))
          await saveVideoResource(this.env,request.operation,value,timestamp,request.maxAgeMs);
        return withDiagnostics(successFromEntry(entry,'miss'));
      }
      try {
        await this.env.YOUTUBE_CACHE.put(request.cacheKey, JSON.stringify(entry), {
          expirationTtl: cacheRetentionSeconds(request.maxAgeMs),
        });
      } catch (error) {
        logCacheFailure('youtube_cache_write_failed', request.resourceType, error);
      }
      return withDiagnostics(successFromEntry(entry, 'miss'));
    } catch (error) {
      if (error instanceof VideoCatalogWriteError) {
        logCacheFailure('video_catalog_write_failed',request.resourceType,error.cause);
        return failureFrom(new YouTubeProcessorError('UNAVAILABLE',error.message,503,true));
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
    const value = await env.YOUTUBE_CACHE.get<YouTubeCacheEntry<T>>(cacheKey, {
      type: 'json',
      cacheTtl: CACHE_READ_TTL_SECONDS,
    });
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
