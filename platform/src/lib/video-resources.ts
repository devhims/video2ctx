import { storyboardSchema, type Storyboard } from '../agents/providers/youtube/storyboard';
import { frameRequestSchema, framesSchema, type VideoFrames } from './youtube-frames-contract';
import { getVideoFrames } from './youtube-frames';
import { runYouTubeOperation, type YouTubeOperation } from './youtube-processor-client';
import type { ExtractionDiagnosticSink } from './extraction-diagnostics';
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
        maxSheets: op.maxSheets ?? 20,
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
function sheetIndexes(board: Storyboard, op: Extract<YouTubeOperation, { kind: 'storyboard' }>): number[] {
  const manifest = board.manifest;
  if (!manifest) throw new Error('Storyboard manifest unavailable.');
  const count = op.maxSheets ?? 20;
  const indexes =
    op.sheetIndexes ??
    (op.timestampsMs
      ? [
          ...new Set(
            op.timestampsMs.map((time) => Math.floor(time / (manifest.framesPerSheet * board.intervalMs))),
          ),
        ]
      : Array.from({ length: Math.min(count, manifest.totalSheets) }, (_, i) =>
          Math.min(count, manifest.totalSheets) === 1
            ? 0
            : Math.round((i * (manifest.totalSheets - 1)) / (Math.min(count, manifest.totalSheets) - 1)),
        ));
  if (
    !Number.isInteger(count) ||
    count < 1 ||
    count > 20 ||
    indexes.length > count ||
    new Set(indexes).size !== indexes.length ||
    indexes.some((index) => !Number.isInteger(index) || index < 0 || index >= manifest.totalSheets) ||
    op.timestampsMs?.some(
      (time) =>
        !Number.isSafeInteger(time) || time < 0 || time > manifest.lastSampleMs + board.intervalMs - 1,
    )
  )
    throw new ApiError(422, 'INVALID_INPUT', 'Invalid storyboard selection.');
  return indexes;
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

export async function readVideoResource(
  env: Env,
  op: VideoResourceOperation,
): Promise<StoredVideoAsset | null> {
  const store = videoCatalog(env);
  const key = videoResourceKey(op);
  if (!store || !key) return null;
  if (op.kind === 'storyboard') {
    const metadata = await store.read<Storyboard>(metadataKey(op.id));
    if (!metadata) return null;
    if (op.metadataOnly) return metadata;
    const indexes = sheetIndexes(metadata.value, op);
    const sheets = await Promise.all(
      indexes.map(async (index) => store.read<Storyboard>(await sheetKey(metadata.value, index))),
    );
    if (sheets.some((sheet) => !sheet)) return null;
    const present = sheets.filter((sheet): sheet is StoredVideoAsset<Storyboard> => !!sheet);
    return combined(
      boardWithSheets(
        metadata.value,
        op,
        present.map((sheet) => sheet.value),
      ),
      [metadata, ...present],
    );
  }
  if (op.kind === 'frames') {
    const assets = await Promise.all(
      op.timestampsMs.map((time) => store.read<VideoFrames>(frameKey(op, time))),
    );
    if (assets.some((asset) => !asset)) return null;
    const present = assets.filter((asset): asset is StoredVideoAsset<VideoFrames> => !!asset);
    return combined(
      framesSchema.parse({
        videoId: op.id,
        frames: present.flatMap((asset) => asset.value.frames),
        failures: [],
        meta: { partial: false, warnings: [] },
      }),
      present,
    );
  }
  const stored = await store.read(key);
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
        // Metadata was loaded separately; saving images must not renew its freshness.
        const expected = sheetIndexes(board, op);
        for (const sheet of board.sheets) {
          const index = sheet.firstFrameIndex / board.manifest.framesPerSheet;
          if (!Number.isInteger(index) || !expected.includes(index))
            throw new Error('Unexpected storyboard sheet.');
          await save(
            await sheetKey(board, index),
            {
              ...board,
              sheets: [sheet],
              selection: { mode: 'indexes', requestedSheetIndexes: [index] },
              meta: { ...board.meta, partial: false },
            },
            fetchedAt,
            maxAgeMs,
            true,
            {
              startMs: sheet.firstFrameIndex * sheet.intervalMs,
              endMs: (sheet.firstFrameIndex + sheet.frameCount - 1) * sheet.intervalMs,
              frameCount: sheet.frameCount,
            },
          );
        }
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
    for (const frame of frames.frames)
      await save(
        frameKey(op, frame.timestampMs),
        { ...frames, frames: [frame], failures: [], meta: { ...frames.meta, partial: false } },
        fetchedAt,
        maxAgeMs,
        true,
        { timestampMs: frame.timestampMs, width: frame.width, height: frame.height, maxWidth: op.maxWidth },
      );
    return references;
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
): Promise<unknown> {
  const store = videoCatalog(env);
  if (op.kind === 'frames') {
    const request = frameRequestSchema.parse({
      videoId: op.id,
      timestampsMs: op.timestampsMs,
      maxWidth: op.maxWidth,
    });
    const saved =
      store && !refresh
        ? await Promise.all(request.timestampsMs.map((time) => store.read<VideoFrames>(frameKey(op, time))))
        : [];
    const hits = saved.filter(
      (asset): asset is StoredVideoAsset<VideoFrames> => !!asset && asset.freshUntil > Date.now(),
    );
    const times = new Set(hits.flatMap((asset) => asset.value.frames.map((frame) => frame.timestampMs)));
    const missing = request.timestampsMs.filter((time) => !times.has(time));
    const fetchedAt = Date.now();
    const fetched = missing.length
      ? await getVideoFrames(
          env,
          { ...request, timestampsMs: missing },
          undefined,
          { extractionTimeoutMs: op.extractionTimeoutMs },
          diagnostic,
        )
      : undefined;
    const versions = fetched
      ? await saveVideoResource(env, op, fetched, fetchedAt, VIDEO_MAX_AGE.frames)
      : [];
    onVersions?.([...hits.flatMap((hit) => hit.catalogVersions ?? []), ...versions]);
    return framesSchema.parse({
      videoId: op.id,
      frames: [...hits.flatMap((asset) => asset.value.frames), ...(fetched?.frames ?? [])].sort(
        (a, b) => a.timestampMs - b.timestampMs,
      ),
      failures: fetched?.failures ?? [],
      meta: { partial: !!fetched?.failures.length, warnings: fetched?.meta.warnings ?? [] },
    });
  }
  if (op.kind !== 'storyboard' || !store || op.metadataOnly) return runYouTubeOperation(env, op, diagnostic);
  let metadata = !refresh ? await store.read<Storyboard>(metadataKey(op.id)) : null;
  if (!metadata || metadata.freshUntil <= Date.now()) {
    const metadataOp = { kind: 'storyboard', id: op.id, metadataOnly: true } as const;
    const fetchedAt = Date.now();
    const value = await runYouTubeOperation(env, metadataOp, diagnostic);
    const catalogVersions = await saveVideoResource(
      env,
      metadataOp,
      value,
      fetchedAt,
      VIDEO_MAX_AGE.storyboard,
    );
    metadata = {
      value,
      fetchedAt,
      freshUntil: fetchedAt + VIDEO_MAX_AGE.storyboard,
      complete: true,
      catalogVersions,
    };
  }
  const indexes = sheetIndexes(metadata.value, op);
  const saved = await Promise.all(
    indexes.map(async (index) =>
      refresh ? null : store.read<Storyboard>(await sheetKey(metadata.value, index)),
    ),
  );
  const hits = saved.filter(
    (asset): asset is StoredVideoAsset<Storyboard> => !!asset && asset.freshUntil > Date.now(),
  );
  const missing = indexes.filter((_, index) => !saved[index] || saved[index]!.freshUntil <= Date.now());
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
