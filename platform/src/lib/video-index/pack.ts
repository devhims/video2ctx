import { captionRange, estimateTokens, usableCaption, type CountTokens, type IndexedCaption, type Passage } from './passages';
import { dot } from './vectors';

export const DEFAULT_EVIDENCE_TOKENS = 2_000;
/** Captions before each selected passage, so an explanation's introduction is kept. */
const LEAD_IN_CAPTIONS = 2;

export interface RankedPassage {
  passage: Passage;
  score: number;
}

export interface ChapterRange {
  index: number;
  first: number;
  last: number;
}

/** One selected passage with its lead-in, in time order. */
export interface EvidenceExcerpt {
  passage: number;
  first: number;
  last: number;
  /** Usable captions from first through last. */
  captions: number[];
}

export interface PackedEvidence {
  passages: number[];
  excerpts: EvidenceExcerpt[];
  captions: number[];
  evidenceTokens: number;
}

/** Passages by similarity to the question; ties keep time order. */
export function rankPassages(passages: readonly Passage[], vectors: readonly Float32Array[], query: Float32Array): RankedPassage[] {
  if (passages.length !== vectors.length) throw new Error('Passage and vector counts differ.');
  return passages.map((passage, index) => ({ passage, score: dot(vectors[index]!, query) }))
    .sort((a, b) => b.score - a.score || a.passage.first - b.passage.first);
}

/** The chapter whose title-and-summary vector best matches the question. */
export function bestChapter(vectors: readonly Float32Array[], query: Float32Array): { index: number; score: number } | undefined {
  let best: { index: number; score: number } | undefined;
  vectors.forEach((vector, index) => {
    const score = dot(vector, query);
    if (!best || score > best.score) best = { index, score };
  });
  return best;
}

/** The chapter that holds most of a passage's captions. */
export function chapterOfPassage(passage: Passage, chapters: readonly ChapterRange[]): number | undefined {
  let best: number | undefined;
  let overlap = 0;
  for (const chapter of chapters) {
    const shared = Math.min(chapter.last, passage.last) - Math.max(chapter.first, passage.first) + 1;
    if (shared > overlap) { overlap = shared; best = chapter.index; }
  }
  return best;
}

function excerptsFor(segments: readonly IndexedCaption[], selected: readonly Passage[]): EvidenceExcerpt[] {
  const sorted = [...selected].sort((a, b) => a.first - b.first);
  return sorted.map((passage, index) => {
    const first = Math.max(0, passage.first - LEAD_IN_CAPTIONS, index > 0 ? sorted[index - 1]!.last + 1 : 0);
    return { passage: passage.index, first, last: passage.last,
      captions: captionRange(first, passage.last).filter(id => usableCaption(segments[id]!.text)) };
  });
}

/** The serialized evidence the budget measures, including caption IDs. */
export function serializedEvidence(segments: readonly IndexedCaption[], excerpts: readonly EvidenceExcerpt[]): string {
  return JSON.stringify({ excerpts: excerpts.map(excerpt => ({
    captions: excerpt.captions.map(id => `${id} ${segments[id]!.text.replace(/[\r\n]+/gu, ' ')}`).join('\n'),
  })) });
}

/**
 * Port of video-index `packEvidence`: whole passages only, each with a two-caption lead-in,
 * sorted by time, with the budget measured over the serialized evidence. Candidates are tried
 * in order; a passage that does not fit is skipped and later, smaller ones may still fit.
 */
export function packEvidence(
  segments: readonly IndexedCaption[],
  candidates: readonly Passage[],
  budget: number,
  countTokens: CountTokens = estimateTokens,
): PackedEvidence {
  if (!Number.isInteger(budget) || budget <= 0) throw new Error('Invalid evidence budget.');
  const chosen: Passage[] = [];
  const seen = new Set<number>();
  for (const passage of candidates) {
    if (seen.has(passage.index)) continue;
    const excerpts = excerptsFor(segments, [...chosen, passage]);
    if (countTokens(serializedEvidence(segments, excerpts)) <= budget) {
      chosen.push(passage);
      seen.add(passage.index);
    }
  }
  const excerpts = excerptsFor(segments, chosen);
  return {
    passages: excerpts.map(excerpt => excerpt.passage),
    excerpts,
    captions: excerpts.flatMap(excerpt => excerpt.captions),
    evidenceTokens: chosen.length ? countTokens(serializedEvidence(segments, excerpts)) : 0,
  };
}

/**
 * Targeted evidence. With a chapter, its best passages fill up to half the budget first; the
 * chapter is added, never used as a filter. The global ranking then fills the rest.
 */
export function selectEvidence(input: {
  segments: readonly IndexedCaption[];
  ranked: readonly RankedPassage[];
  budget: number;
  chapter?: ChapterRange;
  chapters?: readonly ChapterRange[];
  countTokens?: CountTokens;
}): PackedEvidence & { chapterPassages: number[] } {
  const order = input.ranked.map(item => item.passage);
  let chapterPassages: number[] = [];
  if (input.chapter && input.chapters) {
    const inChapter = order.filter(passage => chapterOfPassage(passage, input.chapters!) === input.chapter!.index);
    chapterPassages = packEvidence(input.segments, inChapter, Math.floor(input.budget / 2), input.countTokens).passages;
  }
  const first = order.filter(passage => chapterPassages.includes(passage.index));
  return { ...packEvidence(input.segments, [...first, ...order], input.budget, input.countTokens), chapterPassages };
}
