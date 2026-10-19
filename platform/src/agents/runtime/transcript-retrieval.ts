import { videoCatalog, type VideoAssetReference } from '../../lib/video-catalog';
import { videoResourceKey } from '../../lib/video-resources';
import { startTranscriptIndexBuild } from '../../lib/video-index/build';
import type { TranscriptRetrievalMode, TranscriptRouter } from '../../lib/video-index/config';
import { embeddingQuery, embedTexts } from '../../lib/video-index/embeddings';
import { routeTranscriptScopeWithJev } from '../../lib/video-index/jev';
import { bestChapter, rankPassages, selectEvidence, type EvidenceExcerpt } from '../../lib/video-index/pack';
import type { IndexedCaption } from '../../lib/video-index/passages';
import { readTranscriptIndex, transcriptVersionFromReference, type LoadedTranscriptChapters, type LoadedTranscriptIndex,
  type TranscriptVersion } from '../../lib/video-index/storage';
import type { TranscriptScope } from '../contracts';
import type { ChapterExtractor, ExtractedChapter } from '../providers/youtube/chapter-extractor';
import type { SessionAccess } from './session-evidence';

export type TranscriptRetrievalFallback =
  | 'no_catalog_version' | 'index_read_failed' | 'index_not_ready' | 'caption_count_mismatch' | 'chapters_not_ready'
  | 'embedding_failed' | 'no_evidence_fit' | 'extraction_failed' | 'shadow';

export type TranscriptRetrievalPlan =
  | { mode: 'complete_transcript'; reason: TranscriptRetrievalFallback; scope?: TranscriptScope }
  | {
    mode: 'passage_retrieval';
    scope: Exclude<TranscriptScope, 'whole_video'>;
    excerpts: EvidenceExcerpt[];
    captions: number[];
    evidenceTokens: number;
    chapter?: { index: number; title: string };
  }
  | { mode: 'chapter_extraction'; scope: 'whole_video'; chapters: ExtractedChapter[]; failedChapters: number[] };

export type TranscriptRetrievalEvent = (type: 'transcript.retrieval' | 'transcript.extraction', payload: Record<string, unknown>) => void;

interface LoadedIndexes { index?: LoadedTranscriptIndex; chapters?: LoadedTranscriptChapters }
const PRELOAD_WAIT_MS = 1_500;

/** Per-run access to the shared transcript index. Decided once per transcript version per run. */
export interface TranscriptRetrieval {
  readonly mode: Exclude<TranscriptRetrievalMode, 'full'>;
  resolve(input: { videoId: string; segments: readonly IndexedCaption[]; reference?: VideoAssetReference; signal: AbortSignal }): Promise<TranscriptRetrievalPlan>;
}

export interface TranscriptRetrievalOptions {
  env: Env;
  mode: Exclude<TranscriptRetrievalMode, 'full'>;
  runId: string;
  question: string;
  /** The classifier's scope. Absent means topic, the safe default. */
  scope?: TranscriptScope;
  router: TranscriptRouter;
  evidenceTokens: number;
  chapterMinutes: number;
  extractionConcurrency: number;
  extractChapters: ChapterExtractor;
  onEvent?: TranscriptRetrievalEvent;
  /** Index reads made before classification, reused instead of read again. */
  preloaded?: ReadonlyMap<string, Promise<LoadedIndexes>>;
}

/** Index reads keyed by transcript content hash; at most one catalog read per kind per run. */
function loadIndexes(env: Env, version: TranscriptVersion, chapterMinutes: number, cache: Map<string, Promise<LoadedIndexes>>) {
  let pending = cache.get(version.contentHash);
  if (!pending) {
    pending = readTranscriptIndex(env, version, chapterMinutes);
    cache.set(version.contentHash, pending);
  }
  return pending;
}

/**
 * Before classification, a request about one video supplies that video's chapter titles to the
 * classifier when its transcript is indexed: the session's saved version for a follow-up, otherwise
 * the catalog's current version.
 */
export async function preloadVideoChapters(input: {
  env: Env;
  session?: Pick<SessionAccess, 'brief' | 'transcriptCatalogReference'>;
  videoIds: readonly string[];
  chapterMinutes: number;
}): Promise<{ videoChapters: { videoId: string; titles: string[] }[]; preloaded: Map<string, Promise<LoadedIndexes>> }> {
  const preloaded = new Map<string, Promise<LoadedIndexes>>();
  const session = input.session;
  if (input.videoIds.length !== 1) return { videoChapters: [], preloaded };
  const videoId = input.videoIds[0]!;
  const saved = session?.brief().assets.filter(asset => asset.kind === 'transcript' && asset.videoId === videoId && asset.current).at(-1);
  let version = saved && session?.transcriptCatalogReference ? transcriptVersionFromReference(session.transcriptCatalogReference(saved.version)) : undefined;
  // A first question uses the catalog's current version of the transcript the agent reads. The titles
  // are only a routing hint; retrieval still checks the version the session actually pins.
  if (!version) {
    const key = videoResourceKey({ kind: 'transcript', id: videoId, granularity: 'word' });
    try { version = transcriptVersionFromReference((key && await videoCatalog(input.env)?.currentReference(key)) || undefined); }
    catch { version = undefined; }
  }
  if (!version) return { videoChapters: [], preloaded };
  // Classification does not wait long for this hint; a slower read still serves research.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const loaded = await Promise.race([
      loadIndexes(input.env, version, input.chapterMinutes, preloaded),
      new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), PRELOAD_WAIT_MS); }),
    ]);
    return { videoChapters: loaded?.chapters ? [{ videoId, titles: loaded.chapters.chapters.map(chapter => chapter.title) }] : [], preloaded };
  } catch {
    preloaded.clear();
    return { videoChapters: [], preloaded };
  } finally {
    clearTimeout(timer);
  }
}

export function createTranscriptRetrieval(options: TranscriptRetrievalOptions): TranscriptRetrieval {
  const cache = new Map(options.preloaded ?? []);
  const plans = new Map<string, Promise<TranscriptRetrievalPlan>>();
  const emit = (type: Parameters<TranscriptRetrievalEvent>[0], payload: Record<string, unknown>) => {
    const event = { runId: options.runId, retrieval: options.mode, ...payload };
    console.log(JSON.stringify({ event: type === 'transcript.retrieval' ? 'agent_transcript_retrieval' : 'agent_transcript_extraction', ...event }));
    options.onEvent?.(type, event);
  };

  const plan = async (videoId: string, segments: readonly IndexedCaption[], version: TranscriptVersion, signal: AbortSignal): Promise<TranscriptRetrievalPlan> => {
    const fallback = (reason: TranscriptRetrievalFallback, details: Record<string, unknown> = {}): TranscriptRetrievalPlan => {
      emit('transcript.retrieval', { videoId, mode: 'complete_transcript', fallbackReason: reason, ...details });
      return { mode: 'complete_transcript', reason, ...(typeof details.scope === 'string' ? { scope: details.scope as TranscriptScope } : {}) };
    };
    let loaded: LoadedIndexes;
    try { loaded = await loadIndexes(options.env, version, options.chapterMinutes, cache); }
    catch {
      signal.throwIfAborted();
      return fallback('index_read_failed');
    }
    signal.throwIfAborted();
    // A missing kind may never have been built, for example for transcripts saved before this feature.
    if (!loaded.index || !loaded.chapters) await startTranscriptIndexBuild(options.env, version, 'question');
    if (!loaded.index) return fallback('index_not_ready');
    if (loaded.index.captionCount !== segments.length) return fallback('caption_count_mismatch');
    const chapters = loaded.chapters?.captionCount === segments.length ? loaded.chapters : undefined;

    let scope: TranscriptScope = options.scope ?? 'topic';
    let scopeSource = options.scope ? 'classifier' : 'default';
    if (options.router === 'jev' && chapters) {
      const routed = await routeTranscriptScopeWithJev({ apiKey: options.env.JEV_API_KEY, question: options.question,
        chapterTitles: chapters.chapters.map(chapter => chapter.title), signal });
      if (routed) { scope = routed.scope; scopeSource = 'jev'; }
    }

    if (scope === 'whole_video') {
      if (!chapters) return fallback('chapters_not_ready', { scope, scopeSource });
      if (options.mode === 'shadow') return fallback('shadow', { scope, scopeSource, chapters: chapters.chapters.length });
      const extraction = await options.extractChapters({ question: options.question, segments, chapters: chapters.chapters,
        concurrency: options.extractionConcurrency, signal });
      const points = extraction.chapters.reduce((sum, chapter) => sum + chapter.points.length, 0);
      emit('transcript.extraction', { videoId, chapters: extraction.chapters.length, points,
        failedChapters: extraction.failedChapters, wallMs: extraction.wallMs });
      if (!points) return fallback('extraction_failed', { scope, scopeSource });
      emit('transcript.retrieval', { videoId, mode: 'chapter_extraction', scope, scopeSource, chapters: extraction.chapters.length });
      return { mode: 'chapter_extraction', scope, chapters: extraction.chapters, failedChapters: extraction.failedChapters };
    }

    let query: Float32Array;
    let embedMs: number;
    try {
      const embedded = await embedTexts(options.env.FIREWORKS_API_KEY, [embeddingQuery(options.question)], signal);
      query = embedded.vectors[0]!;
      embedMs = embedded.ms;
    } catch {
      signal.throwIfAborted();
      return fallback('embedding_failed', { scope, scopeSource });
    }
    if (query.length !== loaded.index.dims) return fallback('embedding_failed', { scope, scopeSource });
    const ranked = rankPassages(loaded.index.passages, loaded.index.vectors, query);
    const chosen = scope === 'one_part' && chapters && chapters.dims === query.length ? bestChapter(chapters.vectors, query) : undefined;
    const chapter = chosen ? chapters!.chapters[chosen.index] : undefined;
    const selected = selectEvidence({ segments, ranked, budget: options.evidenceTokens, chapter, chapters: chapters?.chapters });
    const details = { scope, scopeSource, chapterIndex: chapter?.index, passages: selected.passages,
      chapterPassages: selected.chapterPassages, evidenceTokens: selected.evidenceTokens, embedMs };
    if (!selected.captions.length) return fallback('no_evidence_fit', details);
    if (options.mode === 'shadow') return fallback('shadow', details);
    emit('transcript.retrieval', { videoId, mode: 'passage_retrieval', ...details });
    return { mode: 'passage_retrieval', scope: scope as Exclude<TranscriptScope, 'whole_video'>, excerpts: selected.excerpts,
      captions: selected.captions, evidenceTokens: selected.evidenceTokens,
      ...(chapter ? { chapter: { index: chapter.index, title: chapter.title } } : {}) };
  };

  return {
    mode: options.mode,
    resolve: ({ videoId, segments, reference, signal }) => {
      const version = transcriptVersionFromReference(reference);
      if (!version || version.videoId !== videoId) {
        emit('transcript.retrieval', { videoId, mode: 'complete_transcript', fallbackReason: 'no_catalog_version' });
        return Promise.resolve({ mode: 'complete_transcript', reason: 'no_catalog_version' });
      }
      // The first decision for a version holds for the rest of the run.
      let pending = plans.get(version.contentHash);
      if (!pending) {
        pending = plan(videoId, segments, version, signal);
        plans.set(version.contentHash, pending);
        pending.catch(() => plans.delete(version.contentHash));
      }
      return pending;
    },
  };
}
