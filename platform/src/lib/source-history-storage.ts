import { ApiError, sha256 } from './http';
import { videoCatalog, type VideoAssetReference } from './video-catalog';
import { videoResourceKey } from './video-resources';
import { readYouTubeCacheEntry } from './youtube-cache-coordinator';
import { routeInput, withYouTubeMetadata } from './youtube';
import { sourceSnapshotSchema, type SaveSourceInput, type SaveReferencedSource, type SourceReference, type SourceSnapshot } from './source-history';

// Only public provider payloads enter this bucket. Inputs and user selections stay in the user DO.
async function saveShared(env: Env, value: unknown): Promise<string> {
  const payload = JSON.stringify(value);
  const key = `youtube/source-history/${await sha256(payload)}.json`;
  await env.VIDEO_ASSETS.put(key, payload, { httpMetadata: { contentType: 'application/json' } });
  return key;
}

export async function referenceSource(env: Env, value: SaveSourceInput): Promise<SaveReferencedSource> {
  if (!env.VIDEO_ASSETS || !videoCatalog(env)) throw new ApiError(503, 'SOURCE_STORAGE_UNAVAILABLE', 'Recent sources storage is unavailable.');
  const { input, snapshot } = value;
  const cachedPublicData = async (type: string, id: string): Promise<Record<string, unknown>> => {
    const key = `youtube:v1:${await sha256(JSON.stringify([type, id]))}`;
    const cached = await readYouTubeCacheEntry<Record<string, unknown>>(env, key, type);
    if (!cached) throw new ApiError(409, 'SOURCE_ASSET_NOT_SAVED', 'Source data has not finished saving. Inspect the source again.');
    return withYouTubeMetadata(cached.value);
  };
  if (snapshot.kind === 'search') {
    const resolved = routeInput(input);
    if (resolved.kind !== 'search') throw new ApiError(422, 'INVALID_SOURCE', 'Expected search terms.');
    const key = await sha256(JSON.stringify({ query: resolved.query, filters: { type: 'video' } }));
    const search = await cachedPublicData('search-v3', key);
    const items = (search.results as Array<{ type: string }>).filter(item => item.type === 'video');
    return { input, title: input, snapshot: {
      kind: 'search', selectedData: snapshot.selectedData, results: await saveShared(env, items),
    } };
  }
  const source = snapshot.inspector;
  const assets: Partial<Record<'metadata' | 'transcript' | 'comments', VideoAssetReference>> = {};
  let data: Record<string, unknown> = {};
  if (source.type === 'video') {
    const operations = [
      { field: 'metadata' as const, op: { kind: 'video' as const, id: source.id } },
      ...(source.loadedData.includes('transcript') ? [{ field: 'transcript' as const, op: { kind: 'transcript' as const, id: source.id, granularity: 'word' as const } }] : []),
      ...(source.loadedData.includes('comments') ? [{ field: 'comments' as const, op: { kind: 'comments' as const, id: source.id } }] : []),
    ];
    await Promise.all(operations.map(async ({ field, op }) => {
      if (source.dataErrors[field]) return;
      const saved = await videoCatalog(env)!.readSaved(videoResourceKey(op)!);
      const reference = saved?.catalogVersions?.[0];
      if (reference) { assets[field] = reference; if (field === 'metadata') data = saved!.value as Record<string, unknown>; }
      else throw new ApiError(409, 'SOURCE_ASSET_NOT_SAVED', 'Source data has not finished saving. Retry the source.');
    }));
  } else data = await cachedPublicData(source.type === 'playlist' ? 'playlist-v2' : 'channel-v5', source.id);
  const channelId = (data.channel as { id?: string } | undefined)?.id;
  const channel = source.loadedData.includes('channel') && !source.dataErrors.channel && channelId
    ? await cachedPublicData('channel-v5', channelId) : undefined;
  return { input, title: String(data.title ?? data.name ?? input).slice(0, 300), snapshot: {
    kind: 'inspection', inspector: { provider: source.provider, type: source.type, id: source.id,
      requestedData: source.requestedData, dataErrors: source.dataErrors, assets,
      entity: source.type !== 'video' ? await saveShared(env, data) : undefined,
      channel: channel ? await saveShared(env, channel) : undefined,
    },
  } };
}

export async function restoreSource(env: Env, reference: SourceReference): Promise<SourceSnapshot> {
  const readShared = async (key: string) => {
    const object = await env.VIDEO_ASSETS.get(key);
    if (!object) throw new ApiError(404, 'SOURCE_ASSET_MISSING', 'Saved source data is unavailable. Inspect this source again.');
    const payload = await object.text();
    if (`youtube/source-history/${await sha256(payload)}.json` !== key) throw new ApiError(500, 'SOURCE_ASSET_INVALID', 'Saved source data could not be verified.');
    return JSON.parse(payload);
  };
  if (reference.kind === 'search') return sourceSnapshotSchema.parse({
    kind: 'search', selectedData: reference.selectedData, items: await readShared(reference.results),
  });
  const { assets, entity, channel, ...source } = reference.inspector;
  const restored: Record<string, unknown> = { ...source,
    data: entity ? await readShared(entity) : { id: source.id, url: `https://youtube.com/watch?v=${encodeURIComponent(source.id)}` },
    channel: channel ? await readShared(channel) : undefined,
  };
  await Promise.all(Object.entries(assets).map(async ([field, asset]) => {
    if (!asset) return;
    const stored = await videoCatalog(env)?.readVersion(asset);
    if (!stored) throw new ApiError(404, 'SOURCE_ASSET_MISSING', 'Saved source data is unavailable. Inspect this source again.');
    const value = { ...withYouTubeMetadata(stored.value as Record<string, unknown>), freshness: { state: 'stored', fetchedAt: new Date(stored.fetchedAt).toISOString() } };
    restored[field === 'metadata' ? 'data' : field] = value;
  }));
  return sourceSnapshotSchema.parse({ kind: 'inspection', inspector: restored });
}
