import type { LanguageModel } from 'ai';
import { sha256 } from '../http';
import { videoCatalog, type VideoCatalog } from '../video-catalog';
import { videoResourceKey } from '../video-resources';
import { buildChapters, CHAPTER_VERSION } from './chapters';
import { chapterMinutes, transcriptRetrievalMode } from './config';
import { embedTexts } from './embeddings';
import { buildPassages, PASSAGE_VERSION, passageText, type IndexedCaption } from './passages';
import { hasTranscriptChapters, hasTranscriptIndex, saveTranscriptChapters, saveTranscriptIndex, type TranscriptVersion } from './storage';
import { encodeVector } from './vectors';

export interface TranscriptIndexBuildParams extends TranscriptVersion {
  source: 'publish' | 'question';
  /** Chapter density at enqueue time, so the build and its readers agree on the chapters variant. */
  chapterMinutes: number;
}

export type BuildStepResult =
  | { status: 'built'; count: number; ms: number }
  | { status: 'exists' }
  | { status: 'skipped'; reason: 'VIDEO_TOO_LONG' | 'NO_USABLE_CAPTIONS' };

/**
 * Deterministic, so duplicate starts for one transcript version address the same instance. Every
 * input that changes an artifact key is part of the identity: a new chapter density or builder
 * version starts a new instance instead of reusing a completed one with the old payload.
 */
export async function transcriptIndexInstanceId(version: TranscriptVersion, chapterMinutes: number): Promise<string> {
  return `transcript-index-${await sha256(JSON.stringify([version.videoId, version.variant, version.contentHash,
    PASSAGE_VERSION, CHAPTER_VERSION, chapterMinutes]))}`;
}

/**
 * Starts the background build once per transcript version. A duplicate start is a no-op; an
 * instance that ended in failure is restarted, so the next question makes a fresh attempt.
 * Never throws: answering must not depend on indexing.
 */
export async function startTranscriptIndexBuild(env: Env, version: TranscriptVersion, source: TranscriptIndexBuildParams['source']):
  Promise<'disabled' | 'unavailable' | 'started' | 'running' | 'restarted' | 'complete' | 'failed'> {
  if (transcriptRetrievalMode(env) === 'full') return 'disabled';
  const workflow = env.TRANSCRIPT_INDEX_WORKFLOW;
  if (!workflow || !/^[a-f0-9]{64}$/.test(version.contentHash)) return 'unavailable';
  const params: TranscriptIndexBuildParams = { videoId: version.videoId, variant: version.variant, contentHash: version.contentHash,
    source, chapterMinutes: chapterMinutes(env) };
  const id = await transcriptIndexInstanceId(version, params.chapterMinutes);
  try {
    await withinEnqueueBudget(workflow.create({ id, params }));
    console.log(JSON.stringify({ event: 'transcript_index_enqueued', videoId: version.videoId, transcriptHash: version.contentHash, source }));
    return 'started';
  } catch (createError) {
    try {
      // A duplicate ID rejects create. Read the existing instance instead.
      const instance = await withinEnqueueBudget(workflow.get(id));
      const { status } = await withinEnqueueBudget(instance.status());
      if (status === 'errored' || status === 'terminated') {
        await withinEnqueueBudget(instance.restart());
        console.log(JSON.stringify({ event: 'transcript_index_enqueued', videoId: version.videoId, transcriptHash: version.contentHash, source, restarted: true }));
        return 'restarted';
      }
      return status === 'complete' ? 'complete' : 'running';
    } catch {
      console.warn(JSON.stringify({ event: 'transcript_index_enqueue_failed', videoId: version.videoId, transcriptHash: version.contentHash,
        source, errorName: createError instanceof Error ? createError.name : 'UnknownError' }));
      return 'failed';
    }
  }
}

/** Enqueueing is optional work on the transcript publication and answering paths. */
const ENQUEUE_TIMEOUT_MS = 2_000;
function withinEnqueueBudget<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([work, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Transcript index enqueue timed out.')), ENQUEUE_TIMEOUT_MS);
  })]).finally(() => clearTimeout(timer));
}

interface StoredTranscript { segments: IndexedCaption[] }

async function loadTranscript(catalog: VideoCatalog, version: TranscriptVersion): Promise<IndexedCaption[]> {
  const stored = await catalog.readVersion<StoredTranscript>({ videoId: version.videoId, kind: 'transcript', variant: version.variant, contentHash: version.contentHash });
  if (!stored || !Array.isArray(stored.value?.segments)) throw new Error('Transcript version is not readable.');
  return stored.value.segments;
}

function tooLong(segments: readonly IndexedCaption[], maxVideoSeconds: number): boolean {
  const endMs = segments.at(-1)?.endMs;
  return typeof endMs === 'number' && endMs > maxVideoSeconds * 1_000;
}

function skipped(version: TranscriptVersion, step: 'passages' | 'chapters', reason: 'VIDEO_TOO_LONG' | 'NO_USABLE_CAPTIONS'): BuildStepResult {
  console.log(JSON.stringify({ event: 'transcript_index_skipped', videoId: version.videoId, transcriptHash: version.contentHash, step, reason }));
  return { status: 'skipped', reason };
}

/** Step 1: passages and their embeddings, saved as transcript_index. */
export async function buildPassageIndex(env: Env, input: TranscriptIndexBuildParams & { maxVideoSeconds: number; signal?: AbortSignal },
  catalog = videoCatalog(env)): Promise<BuildStepResult> {
  if (!catalog) throw new Error('Shared video catalog bindings are required.');
  if (await hasTranscriptIndex(catalog, input)) return { status: 'exists' };
  const segments = await loadTranscript(catalog, input);
  if (tooLong(segments, input.maxVideoSeconds)) return skipped(input, 'passages', 'VIDEO_TOO_LONG');
  const passages = buildPassages(segments);
  if (!passages.length) return skipped(input, 'passages', 'NO_USABLE_CAPTIONS');
  const started = Date.now();
  const embedded = await embedTexts(env.FIREWORKS_API_KEY, passages.map(passage => passageText(segments, passage)), input.signal);
  const dims = embedded.vectors[0]!.length;
  await saveTranscriptIndex(catalog, input, { captionCount: segments.length, dims, passages, vectors: embedded.vectors.map(encodeVector) });
  // Index-time work is shared, so its cost is logged here rather than charged to a run.
  console.log(JSON.stringify({ event: 'transcript_index_built', videoId: input.videoId, transcriptHash: input.contentHash,
    passages: passages.length, dims, embedMs: embedded.ms, embedTokens: embedded.tokens, source: input.source }));
  return { status: 'built', count: passages.length, ms: Date.now() - started };
}

/** Step 2: one chapter call, validation, and chapter vectors, saved as transcript_chapters. */
export async function buildChapterIndex(env: Env, input: TranscriptIndexBuildParams & { maxVideoSeconds: number; model: LanguageModel; signal?: AbortSignal },
  catalog = videoCatalog(env)): Promise<BuildStepResult> {
  if (!catalog) throw new Error('Shared video catalog bindings are required.');
  if (await hasTranscriptChapters(catalog, input, input.chapterMinutes)) return { status: 'exists' };
  const segments = await loadTranscript(catalog, input);
  if (tooLong(segments, input.maxVideoSeconds)) return skipped(input, 'chapters', 'VIDEO_TOO_LONG');
  if (!buildPassages(segments).length) return skipped(input, 'chapters', 'NO_USABLE_CAPTIONS');
  const started = Date.now();
  const metadataKey = videoResourceKey({ kind: 'video', id: input.videoId });
  const metadata = metadataKey ? await catalog.readSaved<{ title?: unknown }>(metadataKey).catch(() => null) : null;
  const title = typeof metadata?.value?.title === 'string' ? metadata.value.title : undefined;
  const built = await buildChapters({ model: input.model, segments, title, minutesPerChapter: input.chapterMinutes, signal: input.signal });
  if (built.capped) console.warn(JSON.stringify({ event: 'transcript_chapters_capped', videoId: input.videoId,
    transcriptHash: input.contentHash, proposed: built.proposed, kept: built.chapters.length, target: built.target }));
  const embedded = await embedTexts(env.FIREWORKS_API_KEY, built.chapters.map(chapter => `${chapter.title}: ${chapter.summary}`), input.signal);
  await saveTranscriptChapters(catalog, input, input.chapterMinutes, { captionCount: segments.length, dims: embedded.vectors[0]!.length,
    chapters: built.chapters, vectors: embedded.vectors.map(encodeVector) });
  console.log(JSON.stringify({ event: 'transcript_chapters_built', videoId: input.videoId, transcriptHash: input.contentHash,
    chapters: built.chapters.length, requestedK: built.target, capped: built.capped, ms: Date.now() - started, chapterMs: built.ms,
    inputTokens: built.usage?.inputTokens, outputTokens: built.usage?.outputTokens, embedTokens: embedded.tokens, source: input.source }));
  return { status: 'built', count: built.chapters.length, ms: Date.now() - started };
}
