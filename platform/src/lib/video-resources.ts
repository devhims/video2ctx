import { countVisualWork, visualSpan } from './visual-diagnostics';
import { timeStoryboardStage } from './storyboard-timing';
import { mapInBatches } from './map-in-batches';
import { storyboardMetadata, storyboardSchema, storyboardSheetIndexes, MAX_STORYBOARD_SHEETS, type Storyboard } from '../agents/providers/youtube/storyboard';
import { frameRequestSchema, framesSchema, type VideoFrames } from './youtube-frames-contract';
import { getVideoFrames } from './youtube-frames';
import { runYouTubeOperation, YouTubeProcessorError, type YouTubeOperation } from './youtube-processor-client';
import { emitExtractionDiagnostic, type ExtractionAttempt, type ExtractionDiagnosticSink } from './extraction-diagnostics';
import {
  videoCatalog,
  type VideoAssetKey,
  type StoredVideoAsset,
  type VideoAssetReference,
} from './video-catalog';
import { ApiError, sha256 } from './http';

export interface FrameOperation {
  kind: 'frames';
  id: string;
  timestampsMs: number[];
  maxWidth: number;
  extractionTimeoutMs: number;
}
export type VideoResourceOperation = YouTubeOperation | FrameOperation;
// Legacy freshness metadata and KV retention windows, not video refetch deadlines.
export const VIDEO_MAX_AGE = {
  video: 30 * 60_000,
  'video-signals': 15 * 60_000,
  transcript: 7 * 86400_000,
  comments: 15 * 60_000,
  'all-comments': 15 * 60_000,
  'caption-tracks': 86400_000,
  storyboard: 7 * 86400_000,
  frames: 7 * 86400_000,
  endscreen: 86400_000,
} as const;

export function videoResourceKey(op: VideoResourceOperation): VideoAssetKey | undefined {
  if (!(op.kind in VIDEO_MAX_AGE) || !('id' in op)) return;
  if (!/^[A-Za-z0-9_-]{11}$/.test(op.id)) throw new ApiError(422, 'INVALID_INPUT', 'Invalid video ID.');
  let variant: unknown = {};
  switch (op.kind) {
    case 'transcript':
      variant = { language: op.lang?.toLowerCase() ?? 'default', granularity: op.granularity };
      break;
    case 'comments':
      variant = { continuation: op.continuation ?? null };
      break;
    case 'all-comments':
      variant = { maxPages: op.maxPages };
      break;
    case 'storyboard':
      variant = {
        metadataOnly: !!op.metadataOnly,
        maxSheets: op.maxSheets ?? MAX_STORYBOARD_SHEETS,
        indexes: op.sheetIndexes ? [...op.sheetIndexes].sort((a, b) => a - b) : null,
        timestamps: op.timestampsMs ? [...new Set(op.timestampsMs)].sort((a, b) => a - b) : null,
      };
      break;
    case 'frames':
      variant = { timestamps: [...new Set(op.timestampsMs)].sort((a, b) => a - b), maxWidth: op.maxWidth };
      break;
  }
  return {
    videoId: op.id,
    kind: op.kind === 'video' ? 'video_metadata' : op.kind,
    variant: JSON.stringify(variant),
  };
}

export function resourceComplete(op: VideoResourceOperation, value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const data = value as { meta?: { partial?: boolean }; segments?: { text: string }[]; complete?: boolean };
  if (data.meta?.partial) return false;
  if (op.kind === 'transcript') return !!data.segments?.some((segment) => segment.text.trim());
  if (op.kind === 'all-comments') return data.complete === true;
  return true;
}

/** Age alone never triggers another fetch of a saved, complete video resource. */
export function reusableVideoResource(op: VideoResourceOperation,
  saved: { value: unknown; freshUntil: number; complete?: boolean }, now = Date.now()): boolean {
  return videoResourceKey(op)
    ? saved.complete !== false && resourceComplete(op, saved.value)
    : saved.freshUntil > now;
}

export function metadataKey(id: string): VideoAssetKey {
  return { videoId: id, kind: 'storyboard_manifest', variant: 'v1' };
}
export async function sheetKey(board: Storyboard, index: number): Promise<VideoAssetKey> {
  const manifest = await sha256(
    JSON.stringify({ frameCount: board.frameCount, intervalMs: board.intervalMs, manifest: board.manifest }),
  );
  return { videoId: board.videoId, kind: 'storyboard_sheet', variant: `${manifest}:${index}` };
}
export function frameKey(op: FrameOperation, time: number): VideoAssetKey {
  return { videoId: op.id, kind: 'frame', variant: `v1:${op.maxWidth}:${time}` };
}
/** Visual selections share a coordinator lookup; metadata reads keep their fast path. */
export function isVisualSelection(op: VideoResourceOperation): op is FrameOperation | Extract<YouTubeOperation, { kind: 'storyboard' }> {
  return op.kind === 'frames' || (op.kind === 'storyboard' && !op.metadataOnly);
}

function combined<T>(value: T, assets: StoredVideoAsset[]): StoredVideoAsset<T> {
  return {
    value,
    fetchedAt: Math.min(...assets.map((asset) => asset.fetchedAt)),
    freshUntil: Math.min(...assets.map((asset) => asset.freshUntil)),
    complete: assets.every((asset) => asset.complete),
    catalogVersions: assets.flatMap((asset) => asset.catalogVersions ?? []),
  };
}
function boardWithSheets(
  metadata: Storyboard,
  op: Extract<YouTubeOperation, { kind: 'storyboard' }>,
  values: Storyboard[],
): Storyboard {
  return storyboardSchema.parse({
    ...metadata,
    sheets: values.flatMap((value) => value.sheets).sort((a, b) => a.firstFrameIndex - b.firstFrameIndex),
    selection: {
      mode: op.sheetIndexes ? 'indexes' : op.timestampsMs ? 'timestamps' : 'spread',
      requestedSheetIndexes: op.sheetIndexes,
      requestedTimestampsMs: op.timestampsMs,
    },
    meta: {
      partial: values.some((value) => value.meta.partial),
      warnings: [...new Set(values.flatMap((value) => value.meta.warnings))],
    },
  });
}

/** Request-local lookup shared by the coordinator and loader, including partial hits. */
export interface StoryboardLookup {
  kind: 'storyboard';
  metadata: StoredVideoAsset<Storyboard> | null;
  hits: StoredVideoAsset<Storyboard>[];
  missing: number[];
  stored: StoredVideoAsset<Storyboard> | null;
}
export async function readStoryboardSelection(
  env: Env,
  op: Extract<YouTubeOperation, { kind: 'storyboard' }>,
): Promise<StoryboardLookup> {
  return timeStoryboardStage(op.id, 'catalog_lookup', async () => {
    countVisualWork('catalogLookupPasses');
    const store = videoCatalog(env);
    const metadata = store ? await store.readSaved<Storyboard>(metadataKey(op.id)) : null;
    if (!metadata?.complete) {
      return { kind: 'storyboard', metadata: null, hits: [], missing: [], stored: null };
    }
    const indexes = storyboardSheetIndexes(metadata.value, op);
    const keys = await Promise.all(indexes.map(index => sheetKey(metadata.value, index)));
    const saved = await store!.readSavedMany<Storyboard>(keys);
    const hits = saved.filter((asset): asset is StoredVideoAsset<Storyboard> => !!asset?.complete);
    const missing = indexes.filter((_, index) => !saved[index]?.complete);
    countVisualWork('catalogHits', hits.length);
    countVisualWork('catalogMisses', missing.length);
    return { kind: 'storyboard', metadata, hits, missing, stored: missing.length ? null : combined(
      boardWithSheets(metadata.value, op, hits.map(asset => asset.value)), [metadata, ...hits]) };
  });
}

export interface FrameLookup {
  kind: 'frames';
  hits: StoredVideoAsset<VideoFrames>[];
  missing: number[];
  stored: StoredVideoAsset<VideoFrames> | null;
  lookupMs: number;
}
export type VisualLookup = StoryboardLookup | FrameLookup;

export async function readFrameSelection(env: Env, op: FrameOperation): Promise<FrameLookup> {
  return visualSpan('catalog_lookup', () => readFrameSelectionImpl(env, op));
}

async function readFrameSelectionImpl(env: Env, op: FrameOperation): Promise<FrameLookup> {
  countVisualWork('catalogLookupPasses');
  const started = Date.now();
  const request = frameRequestSchema.parse({videoId: op.id, timestampsMs: op.timestampsMs, maxWidth: op.maxWidth});
  const times = [...new Set(request.timestampsMs)].sort((a, b) => a - b);
  const store = videoCatalog(env);
  const saved = store ? await store.readSavedMany<VideoFrames>(times.map(time => frameKey(op, time))) : [];
  const hits = saved.filter((asset): asset is StoredVideoAsset<VideoFrames> => !!asset?.complete);
  const present = new Set(hits.flatMap(asset => asset.value.frames.map(frame => frame.timestampMs)));
  const missing = times.filter(time => !present.has(time));
  countVisualWork('catalogHits', times.length - missing.length);
  countVisualWork('catalogMisses', missing.length);
  return {kind: 'frames', hits, missing, lookupMs: Date.now() - started,
    stored: missing.length ? null : combined(framesSchema.parse({videoId: op.id,
      frames: hits.flatMap(asset => asset.value.frames).sort((a, b) => a.timestampMs - b.timestampMs),
      failures: [], meta: {partial: false, warnings: []}}), hits)};
}

export async function readVideoResource(
  env: Env,
  op: VideoResourceOperation,
): Promise<StoredVideoAsset | null> {
  const store = videoCatalog(env);
  const key = videoResourceKey(op);
  if (!store || !key) return null;
  if (op.kind === 'storyboard') {
    if (op.metadataOnly) return store.readSaved<Storyboard>(metadataKey(op.id));
    return (await readStoryboardSelection(env, op)).stored;
  }
  if (op.kind === 'frames') return (await readFrameSelection(env, op)).stored;
  const stored = await store.readSaved(key);
  // Older Workers may still write the legacy kind during a rolling deployment.
  return stored ?? (op.kind === 'video' ? store.read({ ...key, kind: 'video' }) : null);
}

export async function saveVideoResource(
  env: Env,
  op: VideoResourceOperation,
  value: unknown,
  fetchedAt: number,
  maxAgeMs: number,
): Promise<VideoAssetReference[]> {
  const store = videoCatalog(env);
  const key = videoResourceKey(op);
  if (!store || !key) return [];
  const references: VideoAssetReference[] = [];
  const save: typeof store.save = async (...args) => {
    const reference = await store.save(...args);
    references.push(reference);
    return reference;
  };
  if (op.kind === 'storyboard') {
    const board = storyboardSchema.parse(value);
    if (board.videoId !== op.id) throw new Error('Storyboard video mismatch.');
    if (board.manifest) {
      if (!op.metadataOnly) {
        // Saving images must not renew the independently stored manifest freshness.
        const expected = storyboardSheetIndexes(board, op);
        const framesPerSheet = board.manifest.framesPerSheet;
        const writes = await Promise.all(board.sheets.map(async (sheet) => {
          const index = sheet.firstFrameIndex / framesPerSheet;
          if (!Number.isInteger(index) || !expected.includes(index))
            throw new Error('Unexpected storyboard sheet.');
          return {
            key: await sheetKey(board, index),
            value: {
              ...board,
              sheets: [sheet],
              selection: { mode: 'indexes', requestedSheetIndexes: [index] },
              meta: { ...board.meta, partial: false },
            },
            fetchedAt,
            maxAgeMs,
            complete: true,
            coverage: {
              startMs: sheet.firstFrameIndex * sheet.intervalMs,
              endMs: (sheet.firstFrameIndex + sheet.frameCount - 1) * sheet.intervalMs,
              frameCount: sheet.frameCount,
            },
          };
        }));
        const sheetReferences = await timeStoryboardStage(op.id, 'catalog_write', () => store.saveMany(writes));
        references.push(...sheetReferences);
      } else
        await save(metadataKey(op.id), board, fetchedAt, maxAgeMs, resourceComplete(op, board), {
          ...board.manifest,
          intervalMs: board.intervalMs,
        });
    }
    return references;
  }
  if (op.kind === 'frames') {
    const frames = framesSchema.parse(value);
    if (
      frames.videoId !== op.id ||
      frames.frames.some((frame) => !op.timestampsMs.includes(frame.timestampMs))
    )
      throw new Error('Unexpected video frame.');
    return store.saveMany(frames.frames.map(frame => ({
      key: frameKey(op, frame.timestampMs),
      value: { ...frames, frames: [frame], failures: [], meta: { ...frames.meta, partial: false } },
      fetchedAt, maxAgeMs, complete: true,
      coverage: { timestampMs: frame.timestampMs, width: frame.width, height: frame.height, maxWidth: op.maxWidth },
    })));
  }
  const data = value as {
    segments?: unknown[];
    comments?: unknown[];
    continuation?: string;
    complete?: boolean;
  };
  await save(key, value, fetchedAt, maxAgeMs, resourceComplete(op, value), {
    segmentCount: data.segments?.length,
    commentCount: data.comments?.length,
    hasContinuation: !!data.continuation,
    collectionComplete: data.complete,
  });
  return references;
}

/** Only missing visual assets go to a container; successful partial batches survive. */
export async function loadVideoResource(
  env: Env,
  op: VideoResourceOperation,
  diagnostic?: ExtractionDiagnosticSink,
  refresh = false,
  onVersions?: (references: VideoAssetReference[]) => void,
  visualLookup?: VisualLookup,
): Promise<unknown> {
  const store = videoCatalog(env);
  if (op.kind === 'frames') {
    const request = frameRequestSchema.parse({
      videoId: op.id,
      timestampsMs: op.timestampsMs,
      maxWidth: op.maxWidth,
    });
    let lastAttempt: ExtractionAttempt | undefined;
    const lookup = refresh ? undefined : visualLookup?.kind === 'frames' ? visualLookup : await readFrameSelection(env, op);
    const lookupMs = lookup?.lookupMs ?? 0;
    const hits = lookup?.hits ?? [];
    const missing = lookup?.missing ?? [...new Set(request.timestampsMs)].sort((a, b) => a - b);
    const fetchedAt = Date.now();
    let catalogWriteMs: number | undefined;
    let catalogSucceeded = false;
    try {
      const fetched = missing.length
        ? await getVideoFrames(
            env,
            { ...request, timestampsMs: missing },
            undefined,
            { extractionTimeoutMs: op.extractionTimeoutMs },
            diagnostic ? event => {
              lastAttempt = event;
              emitExtractionDiagnostic(diagnostic, event);
            } : undefined,
          )
        : undefined;
      const writeStarted = Date.now();
      let versions: VideoAssetReference[] = [];
      if (fetched) {
        try {
          versions = await visualSpan('catalog_write', () => saveVideoResource(env, op, fetched, fetchedAt, VIDEO_MAX_AGE.frames));
          catalogSucceeded = true;
        } finally {
          catalogWriteMs = Date.now() - writeStarted;
        }
      }
      onVersions?.([...hits.flatMap((hit) => hit.catalogVersions ?? []), ...versions]);
      return framesSchema.parse({
        videoId: op.id,
        frames: [...hits.flatMap((asset) => asset.value.frames), ...(fetched?.frames ?? [])].sort(
          (a, b) => a.timestampMs - b.timestampMs,
        ),
        failures: fetched?.failures ?? [],
        meta: { partial: !!fetched?.failures.length, warnings: fetched?.meta.warnings ?? [] },
      });
    } finally {
      if (lastAttempt && catalogWriteMs !== undefined) {
        // Keep extraction attempts immediate. Storage is a separate diagnostic phase.
        emitExtractionDiagnostic(diagnostic, { ...lastAttempt, phase: 'catalog',
          recordedAt: Date.now(), elapsedMs: lookupMs + catalogWriteMs,
          outcome: catalogSucceeded ? 'success' : 'failed', status: undefined, failureKind: undefined,
          events: [{ stage: 'catalog_lookup', elapsedMs: lookupMs },
            { stage: 'catalog_write', elapsedMs: catalogWriteMs }], droppedEvents: 0 });
      }
    }
  }
  if (op.kind !== 'storyboard') return runYouTubeOperation(env, op, diagnostic);
  if (!store || op.metadataOnly) return storyboardSchema.parse(await runYouTubeOperation(env, op, diagnostic));
  const lookup = refresh ? undefined : visualLookup?.kind === 'storyboard' ? visualLookup : await readStoryboardSelection(env, op);
  const metadata = lookup?.metadata;
  if (!metadata) {
    // A cold or refreshed selection discovers the manifest and downloads images in
    // one container invocation. No second startup or repeated YouTube discovery.
    const fetchedAt = Date.now();
    let fetched: Storyboard;
    try {
      fetched = storyboardSchema.parse(await runYouTubeOperation(env, op, diagnostic));
    } catch (error) {
      // Only a rejected selection needs a metadata recovery request. Successful
      // cold selections retain the single invocation path.
      if (error instanceof YouTubeProcessorError && error.code === 'INVALID_INPUT'
        && (op.sheetIndexes || op.timestampsMs)) {
        let metadata: Storyboard | undefined;
        try {
          metadata = storyboardSchema.parse(await runYouTubeOperation(env,
            { kind: 'storyboard', id: op.id, metadataOnly: true }, diagnostic));
        } catch { /* Preserve the original rejection if guidance cannot be retrieved. */ }
        if (metadata?.videoId === op.id) storyboardSheetIndexes(metadata, op);
      }
      throw error;
    }
    if (fetched.videoId !== op.id) throw new Error('Storyboard video mismatch.');
    countVisualWork('catalogMisses', storyboardSheetIndexes(fetched, op).length);
    const metadataOp = { kind: 'storyboard', id: op.id, metadataOnly: true } as const;
    // Independent assets share no publication dependency. Drain both on failure.
    const versions = await mapInBatches([
      { operation: metadataOp, value: storyboardMetadata(fetched) },
      { operation: op, value: fetched },
    ], item => saveVideoResource(env, item.operation, item.value, fetchedAt, VIDEO_MAX_AGE.storyboard));
    onVersions?.(versions.flat());
    return fetched;
  }
  const hits = lookup!.hits;
  const missing = lookup!.missing;
  const versions = [...(metadata.catalogVersions ?? []), ...hits.flatMap((hit) => hit.catalogVersions ?? [])];
  if (!missing.length) {
    onVersions?.(versions);
    return boardWithSheets(
      metadata.value,
      op,
      hits.map((asset) => asset.value),
    );
  }
  const fetchedAt = Date.now();
  const fetched = await runYouTubeOperation(
    env,
    { ...op, timestampsMs: undefined, sheetIndexes: missing, maxSheets: missing.length },
    diagnostic,
  );
  if (
    JSON.stringify(fetched.manifest) !== JSON.stringify(metadata.value.manifest) ||
    fetched.intervalMs !== metadata.value.intervalMs ||
    fetched.frameCount !== metadata.value.frameCount
  )
    throw new Error('Storyboard changed during retrieval. Refresh its manifest.');
  onVersions?.([
    ...versions,
    ...(await saveVideoResource(env, op, fetched, fetchedAt, VIDEO_MAX_AGE.storyboard)),
  ]);
  return boardWithSheets(metadata.value, op, [...hits.map((asset) => asset.value), fetched]);
}
