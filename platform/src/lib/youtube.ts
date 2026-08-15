import type {
  BrowseOptions,
  ChannelPlaylistSort,
  ChannelVideoSort,
  SearchFilters,
  Transcript,
  Video,
} from 'all-things-youtube';
import { browseDestination } from './youtube-client';
import {
  normalizeBrowseLanguage,
  normalizeBrowseRegion,
} from './browse-contract';
import { ApiError, now } from './http';
import {
  runYouTubeOperation,
  YouTubeProcessorError,
  type YouTubeOperation,
  type YouTubeOperationResult,
} from './youtube-processor-client';
import {
  readYouTubeCacheEntry,
  type CacheStatus as CoordinatorCacheStatus,
  type YouTubeCacheEntry,
  type YouTubeCacheResponse,
} from './youtube-cache-coordinator';

export type UniversalInput =
  | { kind: 'video'; provider: 'youtube'; id: string }
  | { kind: 'channel'; provider: 'youtube'; id: string }
  | { kind: 'playlist'; provider: 'youtube'; id: string }
  | { kind: 'search'; query: string };

export type CacheStatus = CoordinatorCacheStatus;

export interface CachedResult<T> {
  value: T;
  cacheStatus: CacheStatus;
}

export function routeInput(input: string): UniversalInput {
  const value = input.trim();
  if (!value) throw new ApiError(422, 'QUERY_REQUIRED', 'Enter a query, question, or YouTube URL.');
  if (/^[A-Za-z0-9_-]{11}$/.test(value)) return { kind: 'video', provider: 'youtube', id: value };

  try {
    const url = new URL(value);
    if (!['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'].includes(url.hostname)) {
      throw new ApiError(422, 'UNSUPPORTED_URL', 'Only YouTube URLs are supported.');
    }
    if (url.hostname === 'youtu.be') return { kind: 'video', provider: 'youtube', id: validId(url.pathname.slice(1)) };
    const videoId = url.searchParams.get('v');
    if (videoId) return { kind: 'video', provider: 'youtube', id: validId(videoId) };
    const playlistId = url.searchParams.get('list');
    if (playlistId) return { kind: 'playlist', provider: 'youtube', id: validId(playlistId, 200) };
    const path = url.pathname.split('/').filter(Boolean);
    if (path[0] === 'shorts' || path[0] === 'live') return { kind: 'video', provider: 'youtube', id: validId(path[1] ?? '') };
    if (path[0] === 'playlist') throw new ApiError(422, 'PLAYLIST_ID_REQUIRED', 'The playlist URL has no list parameter.');
    if (path[0]?.startsWith('@')) return { kind: 'channel', provider: 'youtube', id: path[0] };
    if (path[0] === 'channel' && path[1]) return { kind: 'channel', provider: 'youtube', id: validId(path[1], 200) };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (/^https?:\/\//i.test(value)) throw new ApiError(422, 'INVALID_URL', 'The URL is not valid.');
  }
  return { kind: 'search', query: value.slice(0, 500) };
}

function validId(value: string, max = 64): string {
  if (!value || value.length > max || !/^[A-Za-z0-9_@.\-]+$/.test(value)) {
    throw new ApiError(422, 'INVALID_YOUTUBE_ID', 'The YouTube identifier is invalid.');
  }
  return value;
}

export function withYouTubeMetadata<T>(value: T): T {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  const metadata = record.meta;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return value;
  return {
    ...record,
    meta: { ...metadata, source: 'allthingsyoutube', provider: 'youtube' },
  } as T;
}

function processorError(error: YouTubeProcessorError): ApiError {
  const status = error.code === 'INVALID_INPUT' ? 422
    : error.code === 'NOT_FOUND' ? 404
    : error.code === 'AUTH_REQUIRED' ? 401
    : error.code === 'RATE_LIMITED' ? 429
    : error.code === 'UNAVAILABLE' || error.code === 'PROCESSOR_BUSY' || error.code === 'PROCESSOR_UNAVAILABLE' ? 503
    : 502;
  return new ApiError(status, error.code, error.message);
}

async function cached<T extends YouTubeOperation>(
  env: Env,
  type: string,
  id: string,
  maxAgeMs: number,
  operation: T,
): Promise<CachedResult<YouTubeOperationResult<T> & { freshness?: Record<string, unknown> }>> {
  const cacheKey = `youtube:v1:${await hash(JSON.stringify([type, id]))}`;
  const existing = await readYouTubeCacheEntry<YouTubeOperationResult<T>>(env, cacheKey, type);

  const timestamp = now();
  if (existing && existing.freshUntil > timestamp) {
    return cachedValue(existing, 'hit');
  }

  let response;
  try {
    const wireResponse = await env.YOUTUBE_REQUEST_COORDINATOR.getByName(cacheKey).getOrLoad(JSON.stringify({
      cacheKey,
      resourceType: type,
      maxAgeMs,
      operation,
    }));
    response = parseCoordinatorResponse(wireResponse);
  } catch (error) {
    if (existing) return cachedValue(existing, 'stale');
    throw new ApiError(
      503,
      'CACHE_COORDINATOR_UNAVAILABLE',
      error instanceof Error ? error.message : 'The YouTube cache coordinator is unavailable.',
    );
  }
  if (!response.ok && response.error) {
    throw processorError(new YouTubeProcessorError(
      response.error.code,
      response.error.message,
      response.error.status,
      response.error.retryable,
    ));
  }
  if (!response.ok || response.value === undefined || response.fetchedAt === undefined || !response.cacheStatus) {
    throw new ApiError(502, 'INVALID_CACHE_COORDINATOR_RESPONSE', 'The YouTube cache coordinator returned an invalid response.');
  }

  const entry: YouTubeCacheEntry<YouTubeOperationResult<T>> = {
    version: 1,
    value: response.value as YouTubeOperationResult<T>,
    fetchedAt: response.fetchedAt,
    freshUntil: response.fetchedAt + maxAgeMs,
  };
  return cachedValue(entry, response.cacheStatus);
}

function parseCoordinatorResponse(value: string): YouTubeCacheResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ApiError(502, 'INVALID_CACHE_COORDINATOR_RESPONSE', 'The YouTube cache coordinator returned invalid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || typeof (parsed as { ok?: unknown }).ok !== 'boolean') {
    throw new ApiError(502, 'INVALID_CACHE_COORDINATOR_RESPONSE', 'The YouTube cache coordinator returned an invalid response.');
  }
  return parsed as YouTubeCacheResponse;
}

function cachedValue<T>(
  entry: YouTubeCacheEntry<T>,
  cacheStatus: CacheStatus,
): CachedResult<T & { freshness?: Record<string, unknown> }> {
  const stale = cacheStatus === 'stale';
  return {
    value: {
      ...withYouTubeMetadata(entry.value),
      freshness: {
        state: stale ? 'stale' : 'fresh',
        fetchedAt: entry.fetchedAt,
        ...(stale ? { reason: 'UPSTREAM_UNAVAILABLE' } : {}),
      },
    },
    cacheStatus,
  };
}

export async function searchYouTube(env: Env, query: string, filters: SearchFilters = {}) {
  return (await searchYouTubeWithCache(env, query, filters)).value;
}

export async function searchYouTubeWithCache(env: Env, query: string, filters: SearchFilters = {}) {
  const key = await hash(JSON.stringify({ query, filters }));
  return cached(env, 'search-v3', key, 5 * 60_000, { kind: 'search', query, filters });
}

export async function browseYouTube(env: Env, options: BrowseOptions = {}) {
  return (await browseYouTubeWithCache(env, options)).value;
}

export async function browseYouTubeWithCache(env: Env, options: BrowseOptions = {}) {
  const normalized = normalizeBrowseOptions(options);
  const key = await hash(JSON.stringify(normalized));
  return cached(env, 'browse-v3', key, 5 * 60_000, { kind: 'browse', options: normalized });
}

export function normalizeBrowseOptions(options: BrowseOptions = {}): BrowseOptions {
  let destination: ReturnType<typeof browseDestination>;
  let region: string;
  let language: string;
  try {
    destination = browseDestination(options.categoryId);
    region = normalizeBrowseRegion(options.region);
    language = normalizeBrowseLanguage(options.language);
  } catch (error) {
    throw new ApiError(422, 'INVALID_BROWSE_OPTIONS', error instanceof Error ? error.message : 'Invalid browse options.');
  }
  if (!destination) {
    throw new ApiError(
      422,
      'BROWSE_CATEGORY_REQUIRED',
      'Choose a browse category: music, news, sports, or live.'
    );
  }
  return { ...options, categoryId: destination.category, region, language };
}

export async function getVideo(env: Env, id: string): Promise<Video> {
  return (await getVideoWithCache(env, id)).value;
}

export function getVideoWithCache(env: Env, id: string) {
  return cached(env, 'video', `v2:${id}`, 30 * 60_000, { kind: 'video', id });
}

export async function getVideoSignals(env: Env, id: string) {
  return (await getVideoSignalsWithCache(env, id)).value;
}

export function getVideoSignalsWithCache(env: Env, id: string) {
  return cached(env, 'video-signals', id, 15 * 60_000, { kind: 'video-signals', id });
}

export async function getChannel(env: Env, id: string) {
  return (await getChannelWithCache(env, id)).value;
}

export function getChannelWithCache(env: Env, id: string) {
  return cached(env, 'channel-v5', id, 60 * 60_000, { kind: 'channel', id });
}

export async function getChannelVideos(
  env: Env,
  id: string,
  continuation?: string,
  sort: ChannelVideoSort = 'latest'
) {
  return (await getChannelVideosWithCache(env, id, continuation, sort)).value;
}

export async function getChannelVideosWithCache(
  env: Env,
  id: string,
  continuation?: string,
  sort: ChannelVideoSort = 'latest'
) {
  const key = `${id}:${sort}:${continuation ?? 'first'}`;
  return cached(env, 'channel-videos-v2', key, 15 * 60_000, {
    kind: 'channel-videos', id, continuation, sort,
  });
}

export async function getChannelPlaylists(
  env: Env,
  id: string,
  continuation?: string,
  sort: ChannelPlaylistSort = 'newest'
) {
  return (await getChannelPlaylistsWithCache(env, id, continuation, sort)).value;
}

export async function getChannelPlaylistsWithCache(
  env: Env,
  id: string,
  continuation?: string,
  sort: ChannelPlaylistSort = 'newest'
) {
  const key = `${id}:${sort}:${continuation ?? 'first'}`;
  return cached(env, 'channel-playlists-v2', key, 15 * 60_000, {
    kind: 'channel-playlists', id, continuation, sort,
  });
}

export async function getPlaylist(env: Env, id: string) {
  return (await getPlaylistWithCache(env, id)).value;
}

export function getPlaylistWithCache(env: Env, id: string) {
  return cached(env, 'playlist-v2', id, 60 * 60_000, { kind: 'playlist', id });
}

export async function getComments(env: Env, id: string, continuation?: string) {
  return (await getCommentsWithCache(env, id, continuation)).value;
}

export function getCommentsWithCache(env: Env, id: string, continuation?: string) {
  const key = `v6:${id}:${continuation ?? 'first'}`;
  return cached(env, 'comments', key, 15 * 60_000, { kind: 'comments', id, continuation });
}

export async function getAllComments(env: Env, id: string) {
  return (await getAllCommentsWithCache(env, id)).value;
}

export function getAllCommentsWithCache(env: Env, id: string) {
  return cached(env, 'all-comments', `v6:${id}`, 15 * 60_000, {
    kind: 'all-comments', id, maxPages: 100,
  });
}

export async function getTranscript(env: Env, id: string, lang?: string): Promise<Transcript> {
  return (await getTranscriptWithCache(env, id, lang)).value;
}

export function getTranscriptWithCache(env: Env, id: string, lang?: string) {
  return cached(env, 'transcript-v5', `${id}:${lang ?? 'original'}`, 7 * 24 * 60 * 60_000, {
    kind: 'transcript', id, lang, granularity: 'word',
  });
}

export async function getCaptionTracks(env: Env, id: string) {
  return withYouTubeMetadata(await runYouTubeOperation(env, { kind: 'caption-tracks', id }));
}

export function getEndscreen(env: Env, id: string) {
  return runYouTubeOperation(env, { kind: 'endscreen', id });
}

async function hash(value: string): Promise<string> {
  const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
