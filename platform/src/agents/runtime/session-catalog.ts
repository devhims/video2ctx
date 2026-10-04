import { projectSessionPayload as projection } from '../../lib/session-payload';
export { canonicalJson as canonicalSessionPayload } from '../../lib/canonical-json';
import type { VerifiedImage } from '../../lib/verified-image';
import { VerifiedStoryboardSheet } from '../../lib/verified-storyboard';
import { VerifiedTextSource } from '../../lib/verified-text-source';
import { VerifiedFrame } from '../../lib/verified-frame';
import { videoCatalog, type VideoAssetKey, type VideoAssetReference } from '../../lib/video-catalog';
import { frameKey, metadataKey, sheetKey, videoResourceKey } from '../../lib/video-resources';
import type { Storyboard } from '../providers/youtube/storyboard';
import type { SessionAssetKind } from './session-evidence';

export interface SessionCatalogReference {
  asset: VideoAssetReference;
  overrides: Record<string, unknown>;
  omitted: string[];
}

/** Public source persistence only. No session IDs, prompts, analyses or citations. */
export class SessionCatalog {
  private readonly catalog;
  private readonly readImages = new WeakMap<object, VerifiedImage[]>();
  constructor(private readonly env: Env) {
    const catalog = videoCatalog(env);
    if (!catalog) throw new Error('Shared video catalog bindings are required.');
    this.catalog = catalog;
  }

  async read(reference: SessionCatalogReference): Promise<unknown | null> {
    const stored = await this.catalog.readVersion<Record<string, unknown>>(reference.asset, reference.asset.kind === 'frame' || reference.asset.kind === 'storyboard_sheet');
    if (!stored) return null;
    const value = { ...stored.value, ...reference.overrides };
    for (const field of reference.omitted) delete value[field];
    if (stored.verifiedImages) this.readImages.set(value, stored.verifiedImages);
    return value;
  }

  verifiedImages(value: unknown): VerifiedImage[] | undefined {
    return value && typeof value === 'object' ? this.readImages.get(value) : undefined;
  }

  async pin(
    kind: SessionAssetKind,
    videoId: string,
    resourceKey: string,
    value: unknown,
    collectedAt: number,
    versions?: VideoAssetReference[],
    onVerifiedImages?: (images: VerifiedImage[]) => void,
    verifiedFrames?: VerifiedFrame[],
    verifiedStoryboards?: VerifiedStoryboardSheet[],
    verifiedTextSource?: VerifiedTextSource,
  ): Promise<SessionCatalogReference> {
    const compatible = (asset: VideoAssetReference) =>
      asset.videoId === videoId &&
      (asset.kind === kind || (kind === 'comments' && asset.kind === 'all-comments'));
    if (versions !== undefined) {
      if (versions.length !== 1 || !compatible(versions[0]!))
        throw new Error('Invalid shared session asset reference.');
      const asset = versions[0]!;
      if (kind === 'frame') {
        const image = verifiedFrames?.flatMap(receipt => receipt instanceof VerifiedFrame
          ? receipt.match(this.env.VIDEO_ASSETS, asset, value) ?? [] : [])[0];
        if (image) {
          const payload = value as Record<string, unknown>;
          const overrides = Object.fromEntries(['meta', 'failures', 'freshness']
            .filter(key => payload[key] !== undefined).map(key => [key, payload[key]]));
          if (JSON.stringify(overrides).length <= 32_000) {
            onVerifiedImages?.([image]);
            return { asset, overrides,
              omitted: ['meta', 'failures', 'freshness'].filter(key => payload[key] === undefined) };
          }
          // A large envelope may be identical to storage. Let projection decide.
        }
      }
      if (kind === 'storyboard_sheet') {
        const verified = verifiedStoryboards?.flatMap(receipt => receipt instanceof VerifiedStoryboardSheet
          ? receipt.match(this.env.VIDEO_ASSETS, asset, value) ?? [] : [])[0];
        if (verified) {
          onVerifiedImages?.([verified.image]);
          return { asset, ...verified.projection };
        }
      }
      if ((kind === 'transcript' || kind === 'comments') && verifiedTextSource instanceof VerifiedTextSource) {
        const verified = verifiedTextSource.match(this.env.VIDEO_ASSETS, asset, value);
        if (verified) return { asset, ...verified };
      }
      const stored = await this.catalog.readVersion(asset, !!onVerifiedImages);
      const overlay = stored && projection(stored.value, value);
      if (!overlay) throw new Error('Session payload does not match its shared asset version.');
      onVerifiedImages?.(stored?.verifiedImages ?? []);
      return { asset, ...overlay };
    }

    // Legacy blobs and older in-flight Workers have no reference attached.
    // Reuse matching current bytes, or retain the historical source without
    // changing the public current pointer or marking old evidence freshly fetched.
    const key = await sourceKey(kind, videoId, resourceKey, value);
    const current = await this.catalog.read(key, !!onVerifiedImages);
    const overlay = current && projection(current.value, value);
    if (overlay && current.catalogVersions?.[0]) {
      onVerifiedImages?.(current.verifiedImages ?? []);
      return { asset: current.catalogVersions[0], ...overlay };
    }
    const source = publicSource(kind, videoId, value);
    const asset = await this.catalog.save(key, source, collectedAt, 0, true, {}, false);
    const verified = await this.catalog.readVersion(asset, !!onVerifiedImages);
    const savedOverlay = verified && projection(verified.value, value);
    if (!savedOverlay) throw new Error('Historical source could not be verified.');
    onVerifiedImages?.(verified?.verifiedImages ?? []);
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
