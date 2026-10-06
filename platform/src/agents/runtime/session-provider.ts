import { visualSpan } from '../../lib/visual-diagnostics';
import { timeStoryboardStage } from '../../lib/storyboard-timing';
import { mapInBatches, FRAME_IO_CONCURRENCY } from '../../lib/map-in-batches';
import type { CachedResult } from '../../lib/youtube';
import { framesSchema, type VideoFrames } from '../../lib/youtube-frames-contract';
import type { YouTubeAgentProvider } from '../providers/youtube/provider';
import { storyboardMetadata, storyboardSchema, storyboardSheetIndexes, type Storyboard } from '../providers/youtube/storyboard';
import { SessionEvidenceStore } from './session-evidence';
import { assertTranscriptWithinLimit } from './video-duration-limit';
import { VisualRetrievalQueue } from './visual-retrieval-queue';

/** Retrieval is reusable independently of the question passed to any analyst. */
export function sessionProvider(
  provider: YouTubeAgentProvider,
  store: SessionEvidenceStore,
  refresh = false,
): YouTubeAgentProvider {
  const refreshed = new Set<string>();
  // Resource keys this run retrieved from the provider, with the claim of that paid
  // retrieval. A later hit or join served only by such keys names their claims; the run
  // ledger prices it against them, never against "fetched earlier" alone.
  const claims = new Map<string, string>();
  const claimed = <T>(result: CachedResult<T>, keys: readonly string[]): CachedResult<T> => {
    const { providerClaim, joinedClaims: _joined, ...rest } = result;
    if (!result.sessionReused) return providerClaim ? { ...rest, providerClaim } : rest;
    const joined = keys.map(key => claims.get(key));
    return keys.length > 0 && joined.every(claim => claim !== undefined)
      ? { ...rest, joinedClaims: [...new Set(joined as string[])] } : rest;
  };
  const visualQueue = new VisualRetrievalQueue();
  const visual = <T>(kind: 'storyboard' | 'frames', videoId: string, signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> => {
    const generation = store.generation();
    return visualQueue.run(videoId, signal, () => {
      if (generation !== store.generation()) throw new Error('Session assets changed during retrieval.');
      return work();
    }, kind);
  };
  const transcriptKey = (id: string, language?: string) => `transcript:${id}:${language?.toLowerCase() ?? 'default'}`;
  return {
    ...provider,
    transcript: async (id, language, options, diagnostic) => {
      const key = transcriptKey(id, language);
      // A saved over-limit transcript is rejected from its stored metadata, before any blob read.
      const saved = store.transcriptOverLimitForKey(key);
      if (saved) throw saved;
      const fresh = (refresh && !refreshed.has(key)) || !!options?.refresh;
      const result = await store.retrieve(
        key,
        'transcript',
        id,
        fresh,
        async () => {
          const fetched = await provider.transcript(id, language, { refresh: fresh }, diagnostic);
          // Reject before saving, so an over-limit transcript never becomes a session asset.
          if (store.maxVideoSeconds !== undefined) assertTranscriptWithinLimit(id, fetched.value, store.maxVideoSeconds);
          const claim = crypto.randomUUID();
          claims.set(key, claim);
          return { ...fetched, providerClaim: claim };
        },
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
      // A transcript saved before the limit existed is reused without the loader above.
      if (store.maxVideoSeconds !== undefined) assertTranscriptWithinLimit(id, result.value, store.maxVideoSeconds);
      if (result.assetVersions?.length) refreshed.add(key);
      if (result.assetVersions?.[0]) {
        const resolvedKey = transcriptKey(
          id,
          result.value.translatedTo?.languageCode ?? result.value.track.languageCode,
        );
        store.alias(resolvedKey, result.assetVersions[0]);
        const claim = claims.get(key);
        if (claim && !result.sessionReused) claims.set(resolvedKey, claim);
        if (!result.sessionReused)
          store.aliasTranscript(
            id,
            result.value.translatedTo?.languageCode ?? result.value.track.languageCode,
            result.value.track.id,
            result.assetVersions[0],
          );
        refreshed.add(resolvedKey);
      }
      return claimed(result, [key]);
    },
    comments: async (id, options = {}) => {
      const key = `comments:${id}:${options.all ?? false}:${options.continuation ?? ''}`;
      const fresh = (refresh && !refreshed.has(key)) || !!options.refresh;
      const result = await store.retrieve(
        key,
        'comments',
        id,
        fresh,
        async () => {
          const fetched = await provider.comments(id, { ...options, refresh: fresh });
          const claim = crypto.randomUUID();
          claims.set(key, claim);
          return { ...fetched, providerClaim: claim };
        },
        (value) => ({ count: value.comments.length, complete: 'complete' in value ? value.complete : false }),
      );
      if (result.assetVersions?.length) refreshed.add(key);
      return claimed(result, [key]);
    },
    storyboard: provider.storyboard
      ? (id, timestamps, options = {}, diagnostic) =>
          visual('storyboard', id, options.signal, async () => {
            options.signal?.throwIfAborted();
            const generation = store.generation();
            const manifestKey = `storyboard:${id}:manifest`;
            const fresh = (refresh && !refreshed.has(manifestKey)) || !!options.refresh;
            let prefetched: CachedResult<Storyboard> | undefined;
            const metadata = await store.retrieve(
              `storyboard:${id}:manifest`,
              'storyboard_manifest',
              id,
              fresh,
              async () => {
                if (options.metadataOnly) return provider.storyboard!(id, undefined,
                  { metadataOnly: true, ...(options.deadlineAt === undefined ? {} : { deadlineAt: options.deadlineAt }), ...(options.signal ? {signal:options.signal} : {}), ...(fresh ? {refresh:true} : {}) }, diagnostic);
                prefetched = await provider.storyboard!(id, timestamps,
                  { ...options, ...(fresh ? {refresh:true} : {}) }, diagnostic);
                return { ...prefetched, value: storyboardMetadata(prefetched.value),
                  catalogVersions: prefetched.catalogVersions?.filter(asset => asset.kind === 'storyboard_manifest') };
              },
              (value) => ({
                totalSheets: value.manifest?.totalSheets,
                totalFrames: value.frameCount,
                intervalMs: value.intervalMs,
                lastSampleMs: value.manifest?.lastSampleMs,
              }),
              (value) => !!value.manifest,
              options.signal,
            );
            if (metadata.assetVersions?.length) refreshed.add(manifestKey);
            options.signal?.throwIfAborted();
            if (options.metadataOnly) return metadata;
            const manifest = metadata.value.manifest;
            if (!manifest) throw new Error('Storyboard manifest unavailable.');
            const indexes = storyboardSheetIndexes(metadata.value, { ...options, timestampsMs: timestamps });
            const manifestVersion = metadata.assetVersions![0]!;
            const results: CachedResult<Storyboard>[] = [];
            const missing: number[] = [];
            const cached = await timeStoryboardStage(id, 'session_lookup', () => mapInBatches(indexes, async (index) => {
              options.signal?.throwIfAborted();
              if (generation !== store.generation()) throw new Error('Session assets changed during retrieval.');
              const key = `storyboard:${id}:${manifestVersion}:${index}`;
              const hit =
                !prefetched && !(refresh && !refreshed.has(key)) && !options.refresh && (await store.lookup<Storyboard>(key));
              return { index, hit };
            }));
            for (const { index, hit } of cached) {
              if (hit) results.push(hit);
              else missing.push(index);
            }
            options.signal?.throwIfAborted();
            const storyboardClaim = missing.length ? crypto.randomUUID() : undefined;
            if (missing.length) {
              const fetched = prefetched ?? await provider.storyboard!(
                id,
                undefined,
                { sheetIndexes: missing, maxSheets: missing.length, ...(options.deadlineAt === undefined ? {} : { deadlineAt: options.deadlineAt }), ...(options.signal ? {signal:options.signal} : {}), ...((refresh || options.refresh) ? {refresh:true} : {}) },
                diagnostic,
              );
              if (generation !== store.generation()) throw new Error('Session assets changed during retrieval.');
              const saved = await timeStoryboardStage(id, 'session_pin', () => mapInBatches(fetched.value.sheets, async (sheet) => {
                options.signal?.throwIfAborted();
                if (generation !== store.generation()) throw new Error('Session assets changed during retrieval.');
                const index = sheet.firstFrameIndex / manifest.framesPerSheet;
                if (!Number.isInteger(index) || !missing.includes(index))
                  throw new Error('Provider returned an unexpected storyboard sheet.');
                const key = `storyboard:${id}:${manifestVersion}:${index}`;
                const value = {
                  ...fetched.value,
                  sheets: [sheet],
                  selection: { mode: 'indexes' as const, requestedSheetIndexes: [index] },
                };
                const result = await store.retrieve(
                  key,
                  'storyboard_sheet',
                  id,
                  true,
                  async () => ({
                    ...fetched,
                    value,
                    catalogVersions: fetched.catalogVersions?.filter(
                      (asset) => asset.kind === 'storyboard_sheet' && asset.variant.endsWith(`:${index}`),
                    ),
                  }),
                  () => ({
                    sheetIndex: index,
                    manifestVersion,
                    startMs: sheet.firstFrameIndex * sheet.intervalMs,
                    endMs: (sheet.firstFrameIndex + sheet.frameCount - 1) * sheet.intervalMs,
                  }),
                  undefined,
                  options.signal,
                );
                refreshed.add(key);
                claims.set(key, storyboardClaim!);
                return result;
              }));
              results.push(...saved);
            }
            if (generation !== store.generation()) throw new Error('Session assets changed during retrieval.');
            options.signal?.throwIfAborted();
            const partial = results.length < indexes.length || results.some((r) => r.value.meta.partial);
            const claim = claimed({ value: null, cacheStatus: 'hit', sessionReused: missing.length === 0, providerClaim: storyboardClaim },
              indexes.map(index => `storyboard:${id}:${manifestVersion}:${index}`));
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
              cacheStatus: results.some(result=>result.cacheStatus==='stale') ? 'stale'
                : results.some(result=>result.cacheStatus==='miss') ? 'miss'
                : results.some(result=>result.cacheStatus==='coalesced') ? 'coalesced' : 'hit',
              sessionReused: missing.length === 0,
              ...(claim.providerClaim ? { providerClaim: claim.providerClaim } : {}),
              ...(claim.joinedClaims ? { joinedClaims: claim.joinedClaims } : {}),
              verifiedImages: results.flatMap(result => result.verifiedImages ?? []),
              assetVersions: [manifestVersion, ...results.flatMap((r) => r.assetVersions ?? [])],
            };
          })
      : undefined,
    frames: provider.frames
      ? (request, signal, limits, diagnostic) =>
          visual('frames', request.videoId, signal, async () => {
            signal?.throwIfAborted();
            const generation = store.generation();
            const maxWidth = request.maxWidth ?? 1920;
            const times = [...new Set(request.timestampsMs)].sort((a, b) => a - b);
            const hits: CachedResult<VideoFrames>[] = [];
            const missing: number[] = [];
            const lookupStarted = Date.now();
            const cached = await visualSpan('session_lookup', () => mapInBatches(times, async time => {
              const key = `frame:${request.videoId}:${maxWidth}:${time}`;
              signal?.throwIfAborted();
              const hit = !(refresh && !refreshed.has(key)) && !limits?.refresh && (await store.lookup<VideoFrames>(key));
              return { time, hit };
            }));
            const frameTimingsMs = { sessionLookup: Date.now() - lookupStarted, retrieval: 0, sessionPin: 0 };
            for (const { time, hit } of cached) {
              if (hit) hits.push(hit); else missing.push(time);
            }
            signal?.throwIfAborted();
            let fetched: CachedResult<VideoFrames> | undefined;
            const framesClaim = missing.length ? crypto.randomUUID() : undefined;
            if (missing.length) {
              // Batch misses once; successful images survive even if other timestamps fail.
              const retrievalStarted = Date.now();
              fetched = await provider.frames!({ ...request, timestampsMs: missing }, signal,
                refresh ? {extractionTimeoutMs:limits?.extractionTimeoutMs??45_000,refresh:true} : limits, diagnostic);
              frameTimingsMs.retrieval = Date.now() - retrievalStarted;
              signal?.throwIfAborted();
              if (generation !== store.generation()) throw new Error('Session assets changed during retrieval.');
              const pinStarted = Date.now();
              const fetchedResult = fetched;
              const pinned = await visualSpan('session_pin', () => mapInBatches(fetchedResult.value.frames, async frame => {
                signal?.throwIfAborted();
                if (generation !== store.generation()) throw new Error('Session assets changed during retrieval.');
                const value: VideoFrames = {
                  ...fetchedResult.value,
                  frames: [frame],
                  failures: [],
                  meta: { ...fetchedResult.value.meta, partial: false },
                };
                const result = await store.retrieve(
                  `frame:${request.videoId}:${maxWidth}:${frame.timestampMs}`,
                  'frame',
                  request.videoId,
                  true,
                  async () => ({
                    value,
                    cacheStatus: fetchedResult.cacheStatus,
                    verifiedFrames: fetchedResult.verifiedFrames,
                    catalogVersions: fetchedResult.catalogVersions?.filter(
                      (asset) =>
                        asset.kind === 'frame' && asset.variant === `v1:${maxWidth}:${frame.timestampMs}`,
                    ),
                  }),
                  () => ({
                    timestampMs: frame.timestampMs,
                    width: frame.width,
                    height: frame.height,
                    maxWidth,
                  }),
                  undefined,
                  signal,
                );
                refreshed.add(`frame:${request.videoId}:${maxWidth}:${frame.timestampMs}`);
                claims.set(`frame:${request.videoId}:${maxWidth}:${frame.timestampMs}`, framesClaim!);
                return result;
              }, FRAME_IO_CONCURRENCY));
              signal?.throwIfAborted();
              if (generation !== store.generation()) throw new Error('Session assets changed during retrieval.');
              hits.push(...pinned);
              frameTimingsMs.sessionPin = Date.now() - pinStarted;
            }
            signal?.throwIfAborted();
            return {
              verifiedImages: hits.flatMap(result => result.verifiedImages ?? []),
              frameTimingsMs,
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
              cacheStatus: fetched?.cacheStatus ?? 'hit',
              sessionReused: missing.length === 0,
              ...(() => {
                const claim = claimed({ value: null, cacheStatus: 'hit', sessionReused: missing.length === 0, providerClaim: framesClaim },
                  times.map(time => `frame:${request.videoId}:${maxWidth}:${time}`));
                return { ...(claim.providerClaim ? { providerClaim: claim.providerClaim } : {}),
                  ...(claim.joinedClaims ? { joinedClaims: claim.joinedClaims } : {}) };
              })(),
              assetVersions: hits.flatMap((r) => r.assetVersions ?? []),
            };
          })
      : undefined,
  };
}
