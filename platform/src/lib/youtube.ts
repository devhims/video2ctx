import * as youtube from 'all-things-youtube';
import type {
  BrowseOptions,
  ChannelPlaylistSort,
  ChannelVideoSort,
  LibraryOptions,
  SearchFilters,
  Transcript,
  Video,
  YouTubeRetryOptions,
} from 'all-things-youtube';
import {
  browseDestination,
  createYouTubeClient,
} from './youtube-client';
import {
  normalizeBrowseLanguage,
  normalizeBrowseRegion,
} from './browse-contract';
import { ApiError, now } from './http';

const retry: YouTubeRetryOptions = {
  onRetry: (event) => console.warn('youtube_retry', event),
};
const packageOptions: LibraryOptions = { retry };
const discoveryClient = createYouTubeClient({ retry });

export type UniversalInput =
  | { kind: 'video'; id: string }
  | { kind: 'channel'; id: string }
  | { kind: 'playlist'; id: string }
  | { kind: 'search'; query: string };

export function routeInput(input: string): UniversalInput {
  const value = input.trim();
  if (!value) throw new ApiError(422, 'QUERY_REQUIRED', 'Enter a query, question, or YouTube URL.');
  if (/^[A-Za-z0-9_-]{11}$/.test(value)) return { kind: 'video', id: value };

  try {
    const url = new URL(value);
    if (!['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'].includes(url.hostname)) {
      throw new ApiError(422, 'UNSUPPORTED_URL', 'Only YouTube URLs are supported.');
    }
    if (url.hostname === 'youtu.be') return { kind: 'video', id: validId(url.pathname.slice(1)) };
    const videoId = url.searchParams.get('v');
    if (videoId) return { kind: 'video', id: validId(videoId) };
    const playlistId = url.searchParams.get('list');
    if (playlistId) return { kind: 'playlist', id: validId(playlistId, 200) };
    const path = url.pathname.split('/').filter(Boolean);
    if (path[0] === 'shorts' || path[0] === 'live') return { kind: 'video', id: validId(path[1] ?? '') };
    if (path[0] === 'playlist') throw new ApiError(422, 'PLAYLIST_ID_REQUIRED', 'The playlist URL has no list parameter.');
    if (path[0]?.startsWith('@')) return { kind: 'channel', id: path[0] };
    if (path[0] === 'channel' && path[1]) return { kind: 'channel', id: validId(path[1], 200) };
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

function publicMetadata<T>(value: T): T {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  const metadata = record.meta;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return value;
  return {
    ...record,
    meta: { ...metadata, source: 'allthingsyoutube' },
  } as T;
}

function packageError(error: youtube.YouTubeClientError): ApiError {
  const status = error.code === 'INVALID_INPUT' ? 422
    : error.code === 'NOT_FOUND' ? 404
    : error.code === 'AUTH_REQUIRED' ? 401
    : error.code === 'RATE_LIMITED' ? 429
    : error.code === 'UNAVAILABLE' ? 503
    : 502;
  return new ApiError(status, error.code, error.message);
}

async function cached<T>(
  env: Env,
  type: string,
  id: string,
  maxAgeMs: number,
  loader: () => Promise<T>
): Promise<T & { freshness?: Record<string, unknown> }> {
  const existing = await env.DB.prepare(
    'SELECT data_json, fetched_at, expires_at FROM entity_snapshots WHERE entity_type = ? AND entity_id = ?'
  ).bind(type, id).first<{ data_json: string; fetched_at: number; expires_at: number }>();
  const timestamp = now();
  if (existing && existing.expires_at > timestamp) {
    return {
      ...publicMetadata(JSON.parse(existing.data_json)),
      freshness: { state: 'fresh', fetchedAt: existing.fetched_at },
    };
  }
  try {
    const loaded = publicMetadata(await loader());
    const provenance = { provider: 'allthingsyoutube', fetchedAt: timestamp };
    await env.DB.prepare(
      `INSERT INTO entity_snapshots
       (entity_type, entity_id, data_json, provenance_json, fetched_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(entity_type, entity_id) DO UPDATE SET
         data_json=excluded.data_json, provenance_json=excluded.provenance_json,
         fetched_at=excluded.fetched_at, expires_at=excluded.expires_at`
    ).bind(type, id, JSON.stringify(loaded), JSON.stringify(provenance), timestamp, timestamp + maxAgeMs).run();
    return { ...loaded, freshness: { state: 'fresh', fetchedAt: timestamp } };
  } catch (error) {
    if (existing) {
      return {
        ...publicMetadata(JSON.parse(existing.data_json)),
        freshness: { state: 'stale', fetchedAt: existing.fetched_at, reason: 'UPSTREAM_UNAVAILABLE' },
      };
    }
    if (error instanceof youtube.YouTubeClientError) throw packageError(error);
    throw new ApiError(502, 'YOUTUBE_UPSTREAM_ERROR', error instanceof Error ? error.message : 'YouTube is unavailable.');
  }
}

export async function searchYouTube(env: Env, query: string, filters: SearchFilters = {}) {
  const key = await hash(JSON.stringify({ query, filters }));
  return cached(env, 'search-v2', key, 5 * 60_000, () => discoveryClient.search(query, filters));
}

export async function browseYouTube(env: Env, options: BrowseOptions = {}) {
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
  const normalized = { ...options, categoryId: destination.category, region, language };
  const key = await hash(JSON.stringify(normalized));
  return cached(env, 'browse-v3', key, 5 * 60_000, () => discoveryClient.browse(normalized));
}

export function getVideo(env: Env, id: string): Promise<Video> {
  return cached(env, 'video', `v2:${id}`, 30 * 60_000, () =>
    youtube.getDetails({ ...packageOptions, videoId: id })
  );
}

export function getVideoSignals(env: Env, id: string) {
  return cached(env, 'video-signals', id, 15 * 60_000, () =>
    discoveryClient.getVideoSignals(id)
  );
}

export function getChannel(env: Env, id: string) {
  return cached(env, 'channel-v5', id, 60 * 60_000, () =>
    youtube.getChannelInfo({ ...packageOptions, channelId: id })
  );
}

export async function getChannelVideos(
  env: Env,
  id: string,
  continuation?: string,
  sort: ChannelVideoSort = 'latest'
) {
  const key = `${id}:${sort}:${continuation ?? 'first'}`;
  return cached(env, 'channel-videos-v2', key, 15 * 60_000, () =>
    youtube.getChannelVideos({ ...packageOptions, channelId: id, continuation, sort })
  );
}

export async function getChannelPlaylists(
  env: Env,
  id: string,
  continuation?: string,
  sort: ChannelPlaylistSort = 'newest'
) {
  const key = `${id}:${sort}:${continuation ?? 'first'}`;
  return cached(env, 'channel-playlists-v2', key, 15 * 60_000, () =>
    youtube.getChannelPlaylists({ ...packageOptions, channelId: id, continuation, sort })
  );
}

export function getPlaylist(env: Env, id: string) {
  return cached(env, 'playlist-v2', id, 60 * 60_000, () =>
    youtube.getPlaylist({ ...packageOptions, playlistId: id })
  );
}

export function getComments(env: Env, id: string, continuation?: string) {
  const key = `v6:${id}:${continuation ?? 'first'}`;
  return cached(env, 'comments', key, 15 * 60_000, () =>
    youtube.getComments({ ...packageOptions, videoId: id, continuation })
  );
}

export function getAllComments(env: Env, id: string) {
  return cached(env, 'all-comments', `v5:${id}`, 15 * 60_000, () =>
    youtube.getComments({ ...packageOptions, videoId: id, all: true, maxPages: 100 })
  );
}

export function getTranscript(env: Env, id: string, lang?: string): Promise<Transcript> {
  return cached(env, 'transcript-v4', `${id}:${lang ?? 'original'}`, 7 * 24 * 60 * 60_000, () =>
    youtube.getTranscript({ ...packageOptions, videoId: id, lang, granularity: 'word' })
  );
}

export function getCaptionTracks(id: string) {
  return youtube.getTracks({ ...packageOptions, videoId: id });
}

export function getEndscreen(id: string) {
  return youtube.getEndscreen({ ...packageOptions, videoId: id });
}

async function hash(value: string): Promise<string> {
  const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
