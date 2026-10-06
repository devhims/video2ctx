import { ApiError, sha256 } from './http';
import { videoCatalog, type VideoAssetReference } from './video-catalog';
import { videoResourceKey } from './video-resources';
import { readYouTubeCacheEntry } from './youtube-cache-coordinator';
import { readSourceResponse } from './source-response-storage';
import { routeInput, withYouTubeMetadata } from './youtube';
import { sourceSnapshotSchema, sourceCommentPageSchema, mergeSourceCommentPages, type SaveSourceInput, type SaveReferencedSource, type SourceReference, type SourceSnapshot } from './source-history';

function thumbnailUrl(data: Record<string, unknown>): string | undefined {
  const images = data.thumbnails as Array<{ url?: string; width?: number }> | undefined;
  return images?.filter(image => typeof image.url === 'string').sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0]?.url;
}

/** Older entries resolve their thumbnail from their existing saved metadata version. */
export async function sourceThumbnail(env: Env, reference: SourceReference): Promise<string | undefined> {
  if (reference.kind !== 'inspection') return;
  if (reference.inspector.thumbnailUrl) return reference.inspector.thumbnailUrl;
  const metadata = reference.inspector.assets.metadata;
  if (metadata) {
    const stored = await videoCatalog(env)?.readVersion<Record<string, unknown>>(metadata);
    return stored ? thumbnailUrl(stored.value) : undefined;
  }
  if (reference.inspector.entity) {
    const object = await env.VIDEO_ASSETS.get(reference.inspector.entity);
    if (object) return thumbnailUrl(await object.json<Record<string, unknown>>());
  }
}

// Only public provider payloads enter this bucket. Inputs and user selections stay in the user DO.
async function saveShared(env: Env, value: unknown): Promise<string> {
  const payload = JSON.stringify(value);
  const key = `youtube/source-history/${await sha256(payload)}.json`;
  await env.VIDEO_ASSETS.put(key, payload, { httpMetadata: { contentType: 'application/json' } });
  return key;
}

export async function referenceSource(env: Env, value: SaveSourceInput, savedComments?: SourceReference): Promise<SaveReferencedSource> {
  if (!env.VIDEO_ASSETS || !videoCatalog(env)) throw new ApiError(503, 'SOURCE_STORAGE_UNAVAILABLE', 'Recent sources storage is unavailable.');
  const { input, snapshot } = value;
  const cachedPublicData = async (type: string, id: string): Promise<Record<string, unknown>> => {
    const key = `youtube:v1:${await sha256(JSON.stringify([type, id]))}`;
    const [saved, cached] = await Promise.all([
      readSourceResponse<Record<string, unknown>>(env, key, type),
      readYouTubeCacheEntry<Record<string, unknown>>(env, key, type),
    ]);
    // Prefer the latest completed response, including when KV retains an older
    // value. KV remains the compatibility path for responses fetched before this rollout.
    const response = saved && (!cached || saved.fetchedAt >= cached.fetchedAt) ? saved : cached;
    if (!response) throw new ApiError(409, 'SOURCE_ASSET_NOT_SAVED', 'Source data has not finished saving. Inspect the source again.');
    return withYouTubeMetadata(response.value);
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
  const retained = savedComments?.kind === 'inspection' && savedComments.inspector.provider === source.provider
    && savedComments.inspector.type === source.type && savedComments.inspector.id === source.id ? savedComments.inspector : undefined;
  if (source.commentsReceipt && !retained) throw new ApiError(409, 'SOURCE_REVISION_MISMATCH', 'The saved comments changed. Reopen this source.');
  if (retained?.assets.comments) assets.comments = retained.assets.comments;
  let data: Record<string, unknown> = {};
  if (source.type === 'video') {
    const operations = [
      { field: 'metadata' as const, op: { kind: 'video' as const, id: source.id } },
      ...(source.loadedData.includes('transcript') ? [{ field: 'transcript' as const, op: { kind: 'transcript' as const, id: source.id, granularity: 'word' as const } }] : []),
      ...(source.loadedData.includes('comments') && !retained ? [{ field: 'comments' as const, op: { kind: 'comments' as const, id: source.id } }] : []),
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
      ...(retained?.commentPages ? { commentPages: retained.commentPages } : {}),
      entity: source.type !== 'video' ? await saveShared(env, data) : undefined,
      channel: channel ? await saveShared(env, channel) : undefined,
      thumbnailUrl: thumbnailUrl(data),
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
  const { assets, entity, channel, commentPages, ...source } = reference.inspector;
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
  if (restored.comments) {
    const pages = [sourceCommentPageSchema.parse(restored.comments)];
    for (const asset of commentPages ?? []) {
      const saved = await videoCatalog(env)?.readSourceVersion(asset);
      if (!saved) throw new ApiError(404, 'SOURCE_ASSET_MISSING', 'A saved comments page is unavailable. Retry loading stored data.');
      pages.push(sourceCommentPageSchema.parse(saved.value));
    }
    restored.comments = mergeSourceCommentPages(pages);
    restored.commentPagesLoaded = pages.length;
  }
  return sourceSnapshotSchema.parse({ kind: 'inspection', inspector: restored });
}

/** Append an already-fetched page to an owned immutable chain. Never calls a provider. */
export async function appendSourceComments(env: Env, reference: SourceReference, continuation: string, asset: VideoAssetReference): Promise<SourceReference> {
  if (reference.kind !== 'inspection' || reference.inspector.type !== 'video' || !reference.inspector.assets.comments) {
    throw new ApiError(409, 'SOURCE_COMMENTS_MISSING', 'Save the first comments page before adding another page.');
  }
  const catalog = videoCatalog(env);
  if (!catalog) throw new ApiError(503, 'SOURCE_STORAGE_UNAVAILABLE', 'Saved source storage is unavailable.');
  const source = reference.inspector;
  const last = source.commentPages?.at(-1) ?? source.assets.comments!;
  const previous = await catalog.readSourceVersion(last);
  if (!previous || sourceCommentPageSchema.parse(previous.value).continuation !== continuation) {
    throw new ApiError(409, 'SOURCE_COMMENTS_MISMATCH', 'This page does not follow the saved comments. Reopen the saved source.');
  }
  const expected = videoResourceKey({ kind: 'comments', id: source.id, continuation })!;
  if (asset.videoId !== expected.videoId || asset.kind !== expected.kind || asset.variant !== expected.variant) throw new ApiError(409, 'SOURCE_COMMENTS_MISMATCH', 'The comments version does not match this page.');
  const saved = await catalog.readSourceVersion(asset);
  if (!saved) throw new ApiError(409, 'SOURCE_ASSET_NOT_SAVED', 'The comments page is not stored yet. Retry saving it.');
  if (sourceCommentPageSchema.parse(saved.value).videoId !== source.id) throw new ApiError(500, 'SOURCE_ASSET_INVALID', 'Saved comments could not be verified.');
  return { ...reference, inspector: { ...source, commentPages: [...(source.commentPages ?? []), asset] } };
}
