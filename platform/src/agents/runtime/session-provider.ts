import type { CachedResult } from '../../lib/youtube';
import { framesSchema, type VideoFrames } from '../../lib/youtube-frames-contract';
import type { YouTubeAgentProvider } from '../providers/youtube/provider';
import { storyboardSchema, type Storyboard } from '../providers/youtube/storyboard';
import { SessionEvidenceStore } from './session-evidence';

/** Retrieval is reusable independently of the question passed to any analyst. */
export function sessionProvider(
  provider: YouTubeAgentProvider,
  store: SessionEvidenceStore,
  refresh = false,
): YouTubeAgentProvider {
  const refreshed = new Set<string>();
  let visualQueue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const generation = store.generation();
    const guarded = () => {
      if (generation !== store.generation()) throw new Error('Session assets changed during retrieval.');
      return work();
    };
    const next = visualQueue.then(guarded, guarded);
    visualQueue = next.catch(() => undefined);
    return next;
  };
  const transcriptKey = (id: string, language?: string) => `transcript:${id}:${language?.toLowerCase() ?? 'default'}`;
  return {
    ...provider,
    transcript: async (id, language, options) => {
      const key = transcriptKey(id, language);
      const fresh = (refresh && !refreshed.has(key)) || !!options?.refresh;
      const result = await store.retrieve(
        key,
        'transcript',
        id,
        fresh,
        () => provider.transcript(id, language, { refresh: fresh }),
        (value) => ({
          language: value.translatedTo?.languageCode ?? value.track.languageCode,
          trackId: value.track.id,
          complete: true,
          segments: value.segments.length,
          startMs: value.segments[0]?.startMs,
          endMs: value.segments.at(-1)?.endMs,
        }),
        (value) =>
          !value.meta.partial &&
          value.segments.length > 0 &&
          value.segments.some((segment) => segment.text.trim().length > 0),
      );
      if (result.assetVersions?.length) refreshed.add(key);
      if (result.assetVersions?.[0]) {
        const resolvedKey = transcriptKey(
          id,
          result.value.translatedTo?.languageCode ?? result.value.track.languageCode,
        );
        store.alias(resolvedKey, result.assetVersions[0]);
        if (!result.sessionReused)
          store.aliasTranscript(
            id,
            result.value.translatedTo?.languageCode ?? result.value.track.languageCode,
            result.value.track.id,
            result.assetVersions[0],
          );
        refreshed.add(resolvedKey);
      }
      return result;
    },
    comments: async (id, options = {}) => {
      const key = `comments:${id}:${options.all ?? false}:${options.continuation ?? ''}`;
      const fresh = (refresh && !refreshed.has(key)) || !!options.refresh;
      const result = await store.retrieve(
        key,
        'comments',
        id,
        fresh,
        () => provider.comments(id, { ...options, refresh: fresh }),
        (value) => ({ count: value.comments.length, complete: 'complete' in value ? value.complete : false }),
      );
      if (result.assetVersions?.length) refreshed.add(key);
      return result;
    },
    storyboard: provider.storyboard
      ? (id, timestamps, options = {}, diagnostic) =>
          serial(async () => {
            const generation = store.generation();
            const manifestKey = `storyboard:${id}:manifest`;
            const fresh = (refresh && !refreshed.has(manifestKey)) || !!options.refresh;
            const metadata = await store.retrieve(
              `storyboard:${id}:manifest`,
              'storyboard_manifest',
              id,
              fresh,
              () => provider.storyboard!(id, undefined, { metadataOnly: true }, diagnostic),
              (value) => ({
                totalSheets: value.manifest?.totalSheets,
                totalFrames: value.frameCount,
                intervalMs: value.intervalMs,
                lastSampleMs: value.manifest?.lastSampleMs,
              }),
              (value) => !!value.manifest,
            );
            if (metadata.assetVersions?.length) refreshed.add(manifestKey);
            if (options.metadataOnly) return metadata;
            const manifest = metadata.value.manifest;
            if (!manifest) throw new Error('Storyboard manifest unavailable.');
            const count = options.maxSheets ?? 20;
            const indexes =
              options.sheetIndexes ??
              (timestamps
                ? [
                    ...new Set(
                      timestamps.map((time) =>
                        Math.floor(time / (manifest.framesPerSheet * metadata.value.intervalMs)),
                      ),
                    ),
                  ]
                : Array.from({ length: Math.min(count, manifest.totalSheets) }, (_, i) =>
                    Math.min(count, manifest.totalSheets) === 1
                      ? 0
                      : Math.round((i * (manifest.totalSheets - 1)) / (Math.min(count, manifest.totalSheets) - 1)),
                  ));
            if (
              indexes.length > count ||
              indexes.some((i) => i < 0 || i >= manifest.totalSheets) ||
              timestamps?.some((t) => t < 0 || t > manifest.lastSampleMs + metadata.value.intervalMs - 1)
            )
              throw new Error('Invalid storyboard selection. Retrieve metadata and select available sheets.');
            const manifestVersion = metadata.assetVersions![0]!;
            const results: CachedResult<Storyboard>[] = [];
            const missing: number[] = [];
            for (const index of indexes) {
              const key = `storyboard:${id}:${manifestVersion}:${index}`;
              const hit =
                !(refresh && !refreshed.has(key)) && !options.refresh && (await store.lookup<Storyboard>(key));
              if (hit) results.push(hit);
              else missing.push(index);
            }
            if (missing.length) {
              const fetched = await provider.storyboard!(
                id,
                undefined,
                { sheetIndexes: missing, maxSheets: missing.length },
                diagnostic,
              );
              if (generation !== store.generation()) throw new Error('Session assets changed during retrieval.');
              for (const sheet of fetched.value.sheets) {
                const index = sheet.firstFrameIndex / manifest.framesPerSheet;
                if (!Number.isInteger(index) || !missing.includes(index))
                  throw new Error('Provider returned an unexpected storyboard sheet.');
                const key = `storyboard:${id}:${manifestVersion}:${index}`;
                const value = {
                  ...fetched.value,
                  sheets: [sheet],
                  selection: { mode: 'indexes' as const, requestedSheetIndexes: [index] },
                };
                results.push(
                  await store.retrieve(
                    key,
                    'storyboard_sheet',
                    id,
                    true,
                    async () => ({ ...fetched, value }),
                    () => ({
                      sheetIndex: index,
                      manifestVersion,
                      startMs: sheet.firstFrameIndex * sheet.intervalMs,
                      endMs: (sheet.firstFrameIndex + sheet.frameCount - 1) * sheet.intervalMs,
                    }),
                  ),
                );
                refreshed.add(key);
              }
            }
            const partial = results.length < indexes.length || results.some((r) => r.value.meta.partial);
            return {
              value: storyboardSchema.parse({
                ...metadata.value,
                sheets: results.flatMap((r) => r.value.sheets).sort((a, b) => a.firstFrameIndex - b.firstFrameIndex),
                selection: {
                  mode: options.sheetIndexes ? 'indexes' : timestamps ? 'timestamps' : 'spread',
                  requestedSheetIndexes: options.sheetIndexes,
                  requestedTimestampsMs: timestamps,
                },
                meta: { partial, warnings: [...new Set(results.flatMap((r) => r.value.meta.warnings))] },
              }),
              cacheStatus: 'miss',
              sessionReused: missing.length === 0,
              assetVersions: [manifestVersion, ...results.flatMap((r) => r.assetVersions ?? [])],
            };
          })
      : undefined,
    frames: provider.frames
      ? (request, signal, limits, diagnostic) =>
          serial(async () => {
            const generation = store.generation();
            const maxWidth = request.maxWidth ?? 1920;
            const times = [...new Set(request.timestampsMs)].sort((a, b) => a - b);
            const hits: CachedResult<VideoFrames>[] = [];
            const missing: number[] = [];
            for (const time of times) {
              const key = `frame:${request.videoId}:${maxWidth}:${time}`;
              const hit = !(refresh && !refreshed.has(key)) && (await store.lookup<VideoFrames>(key));
              if (hit) hits.push(hit);
              else missing.push(time);
            }
            let fetched: CachedResult<VideoFrames> | undefined;
            if (missing.length) {
              // Batch misses once; successful images survive even if other timestamps fail.
              fetched = await provider.frames!({ ...request, timestampsMs: missing }, signal, limits, diagnostic);
              if (generation !== store.generation()) throw new Error('Session assets changed during retrieval.');
              for (const frame of fetched.value.frames) {
                const value: VideoFrames = {
                  ...fetched.value,
                  frames: [frame],
                  failures: [],
                  meta: { ...fetched.value.meta, partial: false },
                };
                refreshed.add(`frame:${request.videoId}:${maxWidth}:${frame.timestampMs}`);
                hits.push(
                  await store.retrieve(
                    `frame:${request.videoId}:${maxWidth}:${frame.timestampMs}`,
                    'frame',
                    request.videoId,
                    refresh,
                    async () => ({ value, cacheStatus: fetched!.cacheStatus }),
                    () => ({ timestampMs: frame.timestampMs, width: frame.width, height: frame.height, maxWidth }),
                  ),
                );
              }
            }
            return {
              value: framesSchema.parse({
                videoId: request.videoId,
                frames: hits.flatMap((r) => r.value.frames).sort((a, b) => a.timestampMs - b.timestampMs),
                failures: fetched?.value.failures ?? [],
                meta: {
                  partial: !!fetched?.value.failures.length,
                  warnings: [
                    ...new Set(hits.flatMap((r) => r.value.meta.warnings).concat(fetched?.value.meta.warnings ?? [])),
                  ],
                },
              }),
              cacheStatus: 'miss',
              sessionReused: missing.length === 0,
              assetVersions: hits.flatMap((r) => r.assetVersions ?? []),
            };
          })
      : undefined,
  };
}
