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
  | 'embedding_failed' | 'no_evidence_fit' | 'extraction_failed' | 'retrieval_timeout' | 'shadow';

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
/** Index reads, the question embedding and Jev routing share this budget. Retrieval is optional. */
const QUERY_BUDGET_MS = 8_000;
/** Whole-video extraction stops here; chapters still running are reported as not covered. */
const EXTRACTION_BUDGET_MS = 25_000;
/** Research time kept for using the complete transcript when retrieval falls back. */
const FALLBACK_RESERVE_MS = 12_000;
const MIN_EXTRACTION_MS = 5_000;

class RetrievalTimeout extends Error {}

/** A signal for optional work: aborted by the run or at the deadline, whichever is first. */
function deadlineSignal(signal: AbortSignal, deadlineAt: number) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal.aborted ? signal.reason : new RetrievalTimeout('Retrieval deadline elapsed.'));
  const timer = setTimeout(abort, Math.max(0, deadlineAt - Date.now()));
  if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  return { signal: controller.signal, dispose: () => { clearTimeout(timer); signal.removeEventListener('abort', abort); } };
}

/** Rejects with RetrievalTimeout when work outlives its signal; work without a signal of its own keeps running unobserved. */
function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Per-run access to the shared transcript index. Decided once per transcript version per run. */
export interface TranscriptRetrieval {
  readonly mode: Exclude<TranscriptRetrievalMode, 'full'>;
  resolve(input: {
    videoId: string;
    segments: readonly IndexedCaption[];
    reference?: VideoAssetReference;
    signal: AbortSignal;
    /** The research deadline. Retrieval leaves time before it to use the complete transcript. */
    deadlineAt?: number;
  }): Promise<TranscriptRetrievalPlan>;
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
  signal?: AbortSignal;
}): Promise<{ videoChapters: { videoId: string; titles: string[] }[]; preloaded: Map<string, Promise<LoadedIndexes>> }> {
  const preloaded = new Map<string, Promise<LoadedIndexes>>();
  if (input.videoIds.length !== 1) return { videoChapters: [], preloaded };
  const videoId = input.videoIds[0]!;
  const lookup = async () => {
    const session = input.session;
    const saved = session?.brief().assets.filter(asset => asset.kind === 'transcript' && asset.videoId === videoId && asset.current).at(-1);
    let version = saved && session?.transcriptCatalogReference ? transcriptVersionFromReference(session.transcriptCatalogReference(saved.version)) : undefined;
    // A first question uses the catalog's current version of the transcript the agent reads. The titles
    // are only a routing hint; retrieval still checks the version the session actually pins.
    if (!version) {
      const key = videoResourceKey({ kind: 'transcript', id: videoId, granularity: 'word' });
      version = transcriptVersionFromReference((key && await videoCatalog(input.env)?.currentReference(key)) || undefined);
    }
    if (!version) return undefined;
    const loaded = await loadIndexes(input.env, version, input.chapterMinutes, preloaded);
    return loaded.chapters ? [{ videoId, titles: loaded.chapters.chapters.map(chapter => chapter.title) }] : undefined;
  };
  // The whole optional hint, version lookup included, is bounded and honors cancellation, so it
  // never consumes the classification budget. A slower read can still serve research.
  const bound = deadlineSignal(input.signal ?? new AbortController().signal, Date.now() + PRELOAD_WAIT_MS);
  try {
    return { videoChapters: await bounded(lookup(), bound.signal) ?? [], preloaded };
  } catch {
    input.signal?.throwIfAborted();
    return { videoChapters: [], preloaded };
  } finally {
    bound.dispose();
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

  const plan = async (videoId: string, segments: readonly IndexedCaption[], version: TranscriptVersion, signal: AbortSignal,
    deadlineAt: number): Promise<TranscriptRetrievalPlan> => {
    const fallback = (reason: TranscriptRetrievalFallback, details: Record<string, unknown> = {}): TranscriptRetrievalPlan => {
      emit('transcript.retrieval', { videoId, mode: 'complete_transcript', fallbackReason: reason, ...details });
      return { mode: 'complete_transcript', reason, ...(typeof details.scope === 'string' ? { scope: details.scope as TranscriptScope } : {}) };
    };
    // Only run cancellation propagates. A missed retrieval deadline means the complete transcript.
    const optional = <T>(work: (bound: AbortSignal) => Promise<T>, until: number) => {
      const bound = deadlineSignal(signal, until);
      return bounded(work(bound.signal), bound.signal).finally(bound.dispose);
    };
    const failed = (error: unknown, reason: TranscriptRetrievalFallback, details?: Record<string, unknown>) => {
      signal.throwIfAborted();
      return fallback(error instanceof RetrievalTimeout ? 'retrieval_timeout' : reason, details);
    };
    const queryDeadline = Math.min(Date.now() + QUERY_BUDGET_MS, deadlineAt - FALLBACK_RESERVE_MS);

    let loaded: LoadedIndexes;
    try { loaded = await optional(() => loadIndexes(options.env, version, options.chapterMinutes, cache), queryDeadline); }
    catch (error) { return failed(error, 'index_read_failed'); }
    // A missing kind may never have been built, for example for transcripts saved before this feature.
    // Starting the build never throws, and answering does not wait for it.
    if (!loaded.index || !loaded.chapters) void startTranscriptIndexBuild(options.env, version, 'question');
    if (!loaded.index) return fallback('index_not_ready');
    if (loaded.index.captionCount !== segments.length) return fallback('caption_count_mismatch');
    const chapters = loaded.chapters?.captionCount === segments.length ? loaded.chapters : undefined;

    let scope: TranscriptScope = options.scope ?? 'topic';
    let scopeSource = options.scope ? 'classifier' : 'default';
    if (options.router === 'jev' && chapters) {
      const routed = await optional(bound => routeTranscriptScopeWithJev({ apiKey: options.env.JEV_API_KEY, question: options.question,
        chapterTitles: chapters.chapters.map(chapter => chapter.title), signal: bound }), queryDeadline).catch(() => {
        signal.throwIfAborted();
        return undefined;
      });
      if (routed) { scope = routed.scope; scopeSource = 'jev'; }
    }

    if (scope === 'whole_video') {
      if (!chapters) return fallback('chapters_not_ready', { scope, scopeSource });
      if (options.mode === 'shadow') return fallback('shadow', { scope, scopeSource, chapters: chapters.chapters.length });
      const extractionDeadline = Math.min(Date.now() + EXTRACTION_BUDGET_MS, deadlineAt - FALLBACK_RESERVE_MS);
      if (extractionDeadline - Date.now() < MIN_EXTRACTION_MS) return fallback('retrieval_timeout', { scope, scopeSource });
      // Chapters unfinished at the deadline fail on their own; finished chapters are kept.
      const bound = deadlineSignal(signal, extractionDeadline);
      let extraction: Awaited<ReturnType<ChapterExtractor>>;
      try {
        extraction = await options.extractChapters({ question: options.question, segments, chapters: chapters.chapters,
          concurrency: options.extractionConcurrency, signal: bound.signal });
      } catch (error) {
        signal.throwIfAborted();
        throw error;
      } finally { bound.dispose(); }
      signal.throwIfAborted();
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
      const embedded = await optional(bound => embedTexts(options.env.FIREWORKS_API_KEY, [embeddingQuery(options.question)], bound,
        { totalMs: Math.max(1, queryDeadline - Date.now()), attempts: 2 }), queryDeadline);
      query = embedded.vectors[0]!;
      embedMs = embedded.ms;
    } catch (error) {
      return failed(error, 'embedding_failed', { scope, scopeSource });
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
    resolve: ({ videoId, segments, reference, signal, deadlineAt = Infinity }) => {
      const version = transcriptVersionFromReference(reference);
      if (!version || version.videoId !== videoId) {
        emit('transcript.retrieval', { videoId, mode: 'complete_transcript', fallbackReason: 'no_catalog_version' });
        return Promise.resolve({ mode: 'complete_transcript', reason: 'no_catalog_version' });
      }
      // The first decision for a version holds for the rest of the run.
      let pending = plans.get(version.contentHash);
      if (!pending) {
        pending = plan(videoId, segments, version, signal, deadlineAt);
        plans.set(version.contentHash, pending);
        pending.catch(() => plans.delete(version.contentHash));
      }
      // Shadow mode only observes: the complete transcript is returned at once, never after retrieval.
      if (options.mode === 'shadow') {
        pending.catch(() => undefined);
        return Promise.resolve({ mode: 'complete_transcript', reason: 'shadow' });
      }
      return pending;
    },
  };
}
