import {
  runYouTubeOperation,
  YouTubeProcessorError,
  type ProcessorErrorCode,
  type YouTubeOperation,
} from './youtube-processor-client';
import { safeErrorLog } from './http';

export type CacheStatus = 'hit' | 'miss' | 'coalesced' | 'stale';

export interface YouTubeCacheEntry<T = unknown> {
  version: 1;
  value: T;
  fetchedAt: number;
  freshUntil: number;
}

export interface YouTubeCacheRequest {
  cacheKey: string;
  resourceType: string;
  maxAgeMs: number;
  operation: YouTubeOperation;
}

export interface YouTubeCacheResponse {
  ok: boolean;
  value?: unknown;
  fetchedAt?: number;
  cacheStatus?: CacheStatus;
  error?: {
    code: ProcessorErrorCode;
    message: string;
    status?: number;
    retryable: boolean;
  };
}

type OperationLoader = (env: Env, operation: YouTubeOperation) => Promise<unknown>;

const CACHE_READ_TTL_SECONDS = 60;
const MINIMUM_CACHE_RETENTION_MS = 7 * 24 * 60 * 60_000;

interface InFlightRequest {
  cacheKey: string;
  promise: Promise<YouTubeCacheResponse>;
}

interface RecentResult {
  cacheKey: string;
  entry: YouTubeCacheEntry;
}

export class YouTubeCacheCoordinatorCore {
  private inFlight?: InFlightRequest;
  private recent?: RecentResult;

  constructor(
    private readonly env: Env,
    private readonly loadOperation: OperationLoader = runYouTubeOperation,
  ) {}

  async getOrLoad(request: YouTubeCacheRequest): Promise<YouTubeCacheResponse> {
    const active = this.inFlight;
    if (active?.cacheKey === request.cacheKey) {
      const shared = await active.promise;
      return shared.ok && shared.cacheStatus === 'miss'
        ? { ...shared, cacheStatus: 'coalesced' }
        : shared;
    }

    const recent = this.recent;
    if (recent?.cacheKey === request.cacheKey && recent.entry.freshUntil > Date.now()) {
      return successFromEntry(recent.entry, 'hit');
    }

    const promise = this.load(request);
    this.inFlight = { cacheKey: request.cacheKey, promise };
    try {
      const response = await promise;
      if (
        response.ok
        && response.cacheStatus !== 'stale'
        && response.value !== undefined
        && response.fetchedAt !== undefined
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
      if (this.inFlight?.promise === promise) this.inFlight = undefined;
    }
  }

  private async load(request: YouTubeCacheRequest): Promise<YouTubeCacheResponse> {
    const existing = await readYouTubeCacheEntry(this.env, request.cacheKey, request.resourceType);
    const timestamp = Date.now();
    if (existing && existing.freshUntil > timestamp) return successFromEntry(existing, 'hit');

    try {
      const value = await this.loadOperation(this.env, request.operation);
      const entry: YouTubeCacheEntry = {
        version: 1,
        value,
        fetchedAt: timestamp,
        freshUntil: timestamp + request.maxAgeMs,
      };
      try {
        await this.env.YOUTUBE_CACHE.put(request.cacheKey, JSON.stringify(entry), {
          expirationTtl: cacheRetentionSeconds(request.maxAgeMs),
        });
      } catch (error) {
        logCacheFailure('youtube_cache_write_failed', request.resourceType, error);
      }
      return successFromEntry(entry, 'miss');
    } catch (error) {
      if (existing) return successFromEntry(existing, 'stale');
      return failureFrom(error);
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
    return isCacheEntry<T>(value) ? value : null;
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
