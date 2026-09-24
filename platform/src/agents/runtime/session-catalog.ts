import { videoCatalog, type VideoAssetKey, type VideoAssetReference } from '../../lib/video-catalog';
import { frameKey, metadataKey, sheetKey, videoResourceKey } from '../../lib/video-resources';
import type { Storyboard } from '../providers/youtube/storyboard';
import type { SessionAssetKind } from './session-evidence';

export interface SessionCatalogReference {
  asset: VideoAssetReference;
  overrides: Record<string, unknown>;
  omitted: string[];
}

// Only response-envelope fields may differ from the immutable source payload.
// Transcript text, comments and image bytes must match the referenced version.
const envelopeFields = new Set(['meta', 'freshness', 'selection', 'failures']);
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  );
}
function projection(source: unknown, value: unknown): Omit<SessionCatalogReference, 'asset'> | undefined {
  if (
    !source ||
    !value ||
    typeof source !== 'object' ||
    typeof value !== 'object' ||
    Array.isArray(source) ||
    Array.isArray(value)
  )
    return;
  const a = source as Record<string, unknown>,
    b = value as Record<string, unknown>;
  const overrides: Record<string, unknown> = {},
    omitted: string[] = [];
  for (const field of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (canonical(a[field]) === canonical(b[field])) continue;
    if (!envelopeFields.has(field)) return;
    if (b[field] === undefined) omitted.push(field);
    else overrides[field] = b[field];
  }
  // Keep source arrays and images out of Durable Object SQLite.
  if (JSON.stringify(overrides).length > 32_000) return;
  return { overrides, omitted };
}

/** Public source persistence only. No session IDs, prompts, analyses or citations. */
export class SessionCatalog {
  private readonly catalog;
  constructor(env: Env) {
    const catalog = videoCatalog(env);
    if (!catalog) throw new Error('Shared video catalog bindings are required.');
    this.catalog = catalog;
  }

  async read(reference: SessionCatalogReference): Promise<unknown | null> {
    const stored = await this.catalog.readVersion<Record<string, unknown>>(reference.asset);
    if (!stored) return null;
    const value = { ...stored.value, ...reference.overrides };
    for (const field of reference.omitted) delete value[field];
    return value;
  }

  async pin(
    kind: SessionAssetKind,
    videoId: string,
    resourceKey: string,
    value: unknown,
    collectedAt: number,
    versions?: VideoAssetReference[],
  ): Promise<SessionCatalogReference> {
    const compatible = (asset: VideoAssetReference) =>
      asset.videoId === videoId &&
      (asset.kind === kind || (kind === 'comments' && asset.kind === 'all-comments'));
    if (versions !== undefined) {
      if (versions.length !== 1 || !compatible(versions[0]!))
        throw new Error('Invalid shared session asset reference.');
      const asset = versions[0]!;
      const stored = await this.catalog.readVersion(asset);
      const overlay = stored && projection(stored.value, value);
      if (!overlay) throw new Error('Session payload does not match its shared asset version.');
      return { asset, ...overlay };
    }

    // Legacy blobs and older in-flight Workers have no reference attached.
    // Reuse matching current bytes, or retain the historical source without
    // changing the public current pointer or marking old evidence freshly fetched.
    const key = await sourceKey(kind, videoId, resourceKey, value);
    const current = await this.catalog.read(key);
    const overlay = current && projection(current.value, value);
    if (overlay && current.catalogVersions?.[0]) return { asset: current.catalogVersions[0], ...overlay };
    const source = publicSource(kind, videoId, value);
    const asset = await this.catalog.save(key, source, collectedAt, 0, true, {}, false);
    const verified = await this.catalog.readVersion(asset);
    const savedOverlay = verified && projection(verified.value, value);
    if (!savedOverlay) throw new Error('Historical source could not be verified.');
    return { asset, ...savedOverlay };
  }
}

async function sourceKey(
  kind: SessionAssetKind,
  videoId: string,
  key: string,
  value: unknown,
): Promise<VideoAssetKey> {
  if (kind === 'transcript' && key.startsWith(`transcript:${videoId}:`)) {
    const language = key.slice(`transcript:${videoId}:`.length);
    return videoResourceKey({
      kind: 'transcript',
      id: videoId,
      lang: language === 'default' ? undefined : language,
      granularity: 'word',
    })!;
  }
  if (kind === 'comments' && key.startsWith(`comments:${videoId}:`)) {
    const rest = key.slice(`comments:${videoId}:`.length);
    if (rest.startsWith('true:'))
      return videoResourceKey({ kind: 'all-comments', id: videoId, maxPages: 100 })!;
    if (rest.startsWith('false:'))
      return videoResourceKey({ kind: 'comments', id: videoId, continuation: rest.slice(6) || undefined })!;
  }
  if (kind === 'storyboard_manifest') return metadataKey(videoId);
  if (kind === 'storyboard_sheet') {
    const board = value as Storyboard;
    if (board.videoId === videoId && board.manifest && board.sheets.length === 1)
      return sheetKey(board, board.sheets[0]!.firstFrameIndex / board.manifest.framesPerSheet);
  }
  if (kind === 'frame') {
    const match = key.match(/^frame:([\w-]{11}):(\d+):(\d+)$/);
    if (match?.[1] === videoId)
      return frameKey(
        {
          kind: 'frames',
          id: videoId,
          maxWidth: Number(match[2]),
          timestampsMs: [],
          extractionTimeoutMs: 45_000,
        },
        Number(match[3]),
      );
  }
  throw new Error('Unsupported legacy session source key.');
}

const sourceFields: Record<SessionAssetKind, Set<string>> = {
  transcript: new Set(['videoId', 'track', 'translatedTo', 'segments', 'granularity', 'text', 'meta']),
  comments: new Set([
    'videoId',
    'totalCount',
    'comments',
    'replyContinuations',
    'newestContinuation',
    'meta',
    'continuation',
    'estimatedTotal',
    'hasMore',
    'complete',
    'pagesFetched',
    'topLevelCount',
    'replyCount',
    'remainingContinuations',
  ]),
  storyboard_manifest: new Set([
    'videoId',
    'frameCount',
    'intervalMs',
    'manifest',
    'selection',
    'sheets',
    'meta',
  ]),
  storyboard_sheet: new Set([
    'videoId',
    'frameCount',
    'intervalMs',
    'manifest',
    'selection',
    'sheets',
    'meta',
  ]),
  frame: new Set(['videoId', 'frames', 'failures', 'meta']),
};
function publicSource(kind: SessionAssetKind, videoId: string, value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !sourceFields[kind])
    throw new Error('Unsupported session source payload.');
  const source = value as Record<string, unknown>;
  if (
    source.videoId !== videoId ||
    Object.keys(source).some((key) => key !== 'freshness' && !sourceFields[kind].has(key))
  )
    throw new Error('Session payload contains unsupported source fields.');
  const { freshness: _freshness, ...data } = source;
  return data;
}

export function sessionCatalog(env: Env): SessionCatalog | undefined {
  return videoCatalog(env) ? new SessionCatalog(env) : undefined;
}
