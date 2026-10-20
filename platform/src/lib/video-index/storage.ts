import { z } from 'zod';
import { videoCatalog, type VideoAssetReference, type VideoCatalog } from '../video-catalog';
import { transcriptChaptersKey, transcriptIndexKey, VIDEO_MAX_AGE } from '../video-resources';
import { CHAPTER_MODEL_ID, CHAPTER_VERSION, type Chapter } from './chapters';
import { EMBEDDING_MODEL } from './embeddings';
import { PASSAGE_VERSION, type Passage } from './passages';
import { decodeVector } from './vectors';

/**
 * The index and chapters live in the shared catalog beside the transcript version they were
 * built from. Payloads hold caption indexes, model-written chapter titles and vectors, never
 * transcript text. Nothing here is attached to a user or session.
 */

const rangeSchema = z.object({ index: z.number().int().nonnegative(), first: z.number().int().nonnegative(), last: z.number().int().nonnegative() })
  .refine(range => range.last >= range.first, 'Range ends before it starts');
const vectorsSchema = z.array(z.string().min(1)).max(2_000);

export const transcriptIndexPayloadSchema = z.object({
  captionCount: z.number().int().positive(),
  dims: z.number().int().positive().max(8_192),
  passages: z.array(rangeSchema).min(1).max(2_000),
  vectors: vectorsSchema,
}).refine(payload => payload.vectors.length === payload.passages.length, 'One vector per passage')
  .refine(payload => payload.passages.every((passage, index) => passage.index === index && passage.last < payload.captionCount), 'Passages must be ordered and in range');

export const transcriptChaptersPayloadSchema = z.object({
  captionCount: z.number().int().positive(),
  dims: z.number().int().positive().max(8_192),
  chapters: z.array(z.object({
    index: z.number().int().nonnegative(), first: z.number().int().nonnegative(), last: z.number().int().nonnegative(),
    title: z.string().min(1).max(300), summary: z.string().min(1).max(1_500),
  })).min(1).max(300),
  vectors: vectorsSchema,
}).refine(payload => payload.vectors.length === payload.chapters.length, 'One vector per chapter')
  .refine(payload => payload.chapters.every((chapter, index) => chapter.index === index && chapter.last < payload.captionCount
    && chapter.last >= chapter.first && (index === 0 ? chapter.first === 0 : chapter.first === payload.chapters[index - 1]!.last + 1)),
  'Chapters must be contiguous and in range');

export type TranscriptIndexPayload = z.infer<typeof transcriptIndexPayloadSchema>;
export type TranscriptChaptersPayload = z.infer<typeof transcriptChaptersPayloadSchema>;

/** The exact transcript version an index belongs to. */
export interface TranscriptVersion {
  videoId: string;
  /** The transcript's catalog variant, such as {"language":"default"}. */
  variant: string;
  contentHash: string;
}

export interface LoadedTranscriptIndex {
  captionCount: number;
  dims: number;
  passages: Passage[];
  vectors: Float32Array[];
}

export interface LoadedTranscriptChapters {
  captionCount: number;
  dims: number;
  chapters: Chapter[];
  vectors: Float32Array[];
}

export function transcriptVersionFromReference(reference: VideoAssetReference | undefined): TranscriptVersion | undefined {
  if (!reference || reference.kind !== 'transcript' || !/^[a-f0-9]{64}$/.test(reference.contentHash)) return undefined;
  return { videoId: reference.videoId, variant: reference.variant, contentHash: reference.contentHash };
}

function transcriptLanguage(variant: string): string {
  try {
    const language = (JSON.parse(variant) as { language?: unknown }).language;
    return typeof language === 'string' && language ? language : 'default';
  } catch { return 'default'; }
}

export function indexKeyFor(version: TranscriptVersion) {
  return transcriptIndexKey(version.videoId, { transcriptHash: version.contentHash, language: transcriptLanguage(version.variant),
    passageVersion: PASSAGE_VERSION, embeddingModel: EMBEDDING_MODEL });
}

export function chaptersKeyFor(version: TranscriptVersion, chapterMinutes: number) {
  return transcriptChaptersKey(version.videoId, { transcriptHash: version.contentHash, language: transcriptLanguage(version.variant),
    chapterVersion: CHAPTER_VERSION, model: CHAPTER_MODEL_ID, embeddingModel: EMBEDDING_MODEL, chapterMinutes });
}

function decodeIndex(payload: TranscriptIndexPayload): LoadedTranscriptIndex {
  return { captionCount: payload.captionCount, dims: payload.dims, passages: payload.passages,
    vectors: payload.vectors.map(vector => decodeVector(vector, payload.dims)) };
}

function decodeChapters(payload: TranscriptChaptersPayload): LoadedTranscriptChapters {
  return { captionCount: payload.captionCount, dims: payload.dims, chapters: payload.chapters,
    vectors: payload.vectors.map(vector => decodeVector(vector, payload.dims)) };
}

/** One D1 lookup per kind; a missing version means not ready. Invalid payloads read as not ready. */
export async function readTranscriptIndex(env: Env, version: TranscriptVersion, chapterMinutes: number, catalog = videoCatalog(env)): Promise<{
  index?: LoadedTranscriptIndex;
  chapters?: LoadedTranscriptChapters;
}> {
  if (!catalog) return {};
  const [index, chapters] = await Promise.all([
    catalog.read<unknown>(indexKeyFor(version)).then(stored => {
      const parsed = stored?.complete ? transcriptIndexPayloadSchema.safeParse(stored.value) : undefined;
      return parsed?.success ? decodeIndex(parsed.data) : undefined;
    }),
    catalog.read<unknown>(chaptersKeyFor(version, chapterMinutes)).then(stored => {
      const parsed = stored?.complete ? transcriptChaptersPayloadSchema.safeParse(stored.value) : undefined;
      return parsed?.success ? decodeChapters(parsed.data) : undefined;
    }),
  ]);
  return { ...(index ? { index } : {}), ...(chapters ? { chapters } : {}) };
}

export async function hasTranscriptIndex(catalog: VideoCatalog, version: TranscriptVersion): Promise<boolean> {
  return !!(await catalog.read(indexKeyFor(version)))?.complete;
}

export async function hasTranscriptChapters(catalog: VideoCatalog, version: TranscriptVersion, chapterMinutes: number): Promise<boolean> {
  return !!(await catalog.read(chaptersKeyFor(version, chapterMinutes)))?.complete;
}

/** Only the index build job writes these kinds, through the catalog's journaled save. */
export function saveTranscriptIndex(catalog: VideoCatalog, version: TranscriptVersion, payload: TranscriptIndexPayload) {
  const value = transcriptIndexPayloadSchema.parse(payload);
  return catalog.save(indexKeyFor(version), value, Date.now(), VIDEO_MAX_AGE.transcript, true,
    { passageCount: value.passages.length, dims: value.dims, captionCount: value.captionCount });
}

export function saveTranscriptChapters(catalog: VideoCatalog, version: TranscriptVersion, chapterMinutes: number, payload: TranscriptChaptersPayload) {
  const value = transcriptChaptersPayloadSchema.parse(payload);
  return catalog.save(chaptersKeyFor(version, chapterMinutes), value, Date.now(), VIDEO_MAX_AGE.transcript, true,
    { chapterCount: value.chapters.length, dims: value.dims, captionCount: value.captionCount });
}
