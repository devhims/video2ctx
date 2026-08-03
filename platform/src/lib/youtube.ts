import {
  browseDestination,
  createYouTubeClient,
} from './youtube-client';
import {
  normalizeBrowseLanguage,
  normalizeBrowseRegion,
} from './browse-contract';
import type {
  BrowseOptions,
  SearchFilters,
  Transcript,
  Video,
} from './youtube-types';
import { ApiError, now } from './http';

const client = createYouTubeClient();

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
    return { ...JSON.parse(existing.data_json), freshness: { state: 'fresh', fetchedAt: existing.fetched_at } };
  }
  try {
    const loaded = await loader();
    const provenance = { provider: 'innertube', fetchedAt: timestamp };
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
        ...JSON.parse(existing.data_json),
        freshness: { state: 'stale', fetchedAt: existing.fetched_at, reason: 'UPSTREAM_UNAVAILABLE' },
      };
    }
    throw new ApiError(502, 'YOUTUBE_UPSTREAM_ERROR', error instanceof Error ? error.message : 'YouTube is unavailable.');
  }
}

export async function searchYouTube(env: Env, query: string, filters: SearchFilters = {}) {
  const key = await hash(JSON.stringify({ query, filters }));
  return cached(env, 'search-v2', key, 5 * 60_000, () => client.search(query, filters));
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
  return cached(env, 'browse-v3', key, 5 * 60_000, () => client.browse(normalized));
}

export function getVideo(env: Env, id: string): Promise<Video> {
  return cached(env, 'video', id, 30 * 60_000, () => client.getVideo(id));
}

export function getVideoSignals(env: Env, id: string) {
  return cached(env, 'video-signals', id, 15 * 60_000, () => client.getVideoSignals(id));
}

export function getChannel(env: Env, id: string) {
  return cached(env, 'channel-v3', id, 60 * 60_000, async () => {
    if (id.startsWith('@')) {
      const result = await client.search(id, { type: 'channel' });
      const channel = result.results.find((item) => item.type === 'channel');
      if (!channel) throw new ApiError(404, 'CHANNEL_NOT_FOUND', `Could not resolve ${id}.`);
      return client.getChannel(channel.id);
    }
    return client.getChannel(id);
  });
}

export function getPlaylist(env: Env, id: string) {
  return cached(env, 'playlist-v2', id, 60 * 60_000, () => client.getPlaylist(id));
}

export function getComments(env: Env, id: string, continuation?: string) {
  const key = `v5:${id}:${continuation ?? 'first'}`;
  return cached(env, 'comments', key, 15 * 60_000, () => client.getComments({ videoId: id, continuation }));
}

export function getAllComments(env: Env, id: string) {
  return cached(env, 'all-comments', `v4:${id}`, 15 * 60_000, () =>
    client.getAllComments({ videoId: id, maxPages: 100 })
  );
}

export async function getTranscript(env: Env, id: string, language = 'en'): Promise<Transcript> {
  return cached(env, 'transcript', `${id}:${language}`, 7 * 24 * 60 * 60_000, async () => {
    const url = new URL('https://extractor.internal/api/subtitles');
    url.searchParams.set('videoID', id);
    url.searchParams.set('lang', language);
    try {
      const response = await env.EXTRACTOR.fetch(new Request(url, {
        headers: { authorization: `Bearer ${env.CAPTION_API_TOKEN}` },
      }));
      if (response.ok) {
        const data = await response.json<{ subtitles: Array<{ text: string; start: number; dur: number }> }>();
        const segments = data.subtitles.map((segment) => ({
          text: segment.text,
          startMs: Math.round(segment.start * 1000),
          durationMs: Math.round(segment.dur * 1000),
          endMs: Math.round((segment.start + segment.dur) * 1000),
        }));
        return {
          videoId: id,
          track: {
            id: `${language}:legacy`, languageCode: language, name: language,
            kind: 'unknown', provenance: 'unknown', isTranslatable: false, isDefault: true,
          },
          granularity: 'segment' as const,
          segments,
          text: segments.map((segment) => segment.text).join('\n'),
          meta: { source: 'innertube' as const, fetchedAt: new Date().toISOString(), partial: false, warnings: [] },
        };
      }
    } catch (error) {
      console.warn('extractor_service_fallback', { id, error });
    }
    return client.getTranscript({ videoId: id, language, granularity: 'word' });
  });
}

export function getCaptionTracks(id: string) {
  return client.getCaptionTracks(id);
}

export function getStoryboards(id: string) {
  return client.getStoryboards(id);
}

export function getEndscreen(id: string) {
  return client.getEndscreen(id);
}

async function hash(value: string): Promise<string> {
  const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
