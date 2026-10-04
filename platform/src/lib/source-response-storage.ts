import { ApiError, sha256 } from './http';
import type { YouTubeCacheEntry } from './youtube-cache-coordinator';

const SOURCE_RESOURCE_TYPES = new Set(['channel-v5', 'playlist-v2', 'search-v3']);

async function responseKey(cacheKey: string): Promise<string> {
  return `youtube/source-responses/v1/${await sha256(cacheKey)}.json`;
}

/** Retain only public data needed by Sources, never the search query or operation. */
export async function saveSourceResponse(env: Env, cacheKey: string, resourceType: string,
  entry: YouTubeCacheEntry, retentionMs: number): Promise<void> {
  if (!env.VIDEO_ASSETS || !SOURCE_RESOURCE_TYPES.has(resourceType)) return;
  const value = entry.value as Record<string, unknown>;
  const publicValue = resourceType === 'search-v3'
    ? { results: (value.results as Array<{ type: string }>).filter(item => item.type === 'video') }
    : value;
  try {
    await env.VIDEO_ASSETS.put(await responseKey(cacheKey), JSON.stringify({
      version: 1, resourceType, value: publicValue, fetchedAt: entry.fetchedAt,
      retainedUntil: entry.fetchedAt + retentionMs,
    }), { httpMetadata: { contentType: 'application/json' } });
  } catch {
    throw new ApiError(503, 'SOURCE_STORAGE_UNAVAILABLE', 'Source data could not be saved. Retry the source.');
  }
}

/** R2 reads remain usable across coordinator eviction and KV propagation delays. */
export async function readSourceResponse<T>(env: Env, cacheKey: string, resourceType: string):
  Promise<{ value: T; fetchedAt: number } | null> {
  if (!env.VIDEO_ASSETS || !SOURCE_RESOURCE_TYPES.has(resourceType)) return null;
  const object = await env.VIDEO_ASSETS.get(await responseKey(cacheKey));
  if (!object) return null;
  const stored = await object.json<unknown>();
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return null;
  const entry = stored as Record<string, unknown>;
  if (entry.version !== 1 || entry.resourceType !== resourceType
    || typeof entry.fetchedAt !== 'number' || !Number.isFinite(entry.fetchedAt)
    || typeof entry.retainedUntil !== 'number' || !Number.isFinite(entry.retainedUntil)
    || entry.retainedUntil <= Date.now() || !entry.value || typeof entry.value !== 'object' || Array.isArray(entry.value)) return null;
  return { value: entry.value as T, fetchedAt: entry.fetchedAt };
}
