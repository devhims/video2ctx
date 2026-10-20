/** Derived, caption-indexed views of one transcript version. Pure code; no model calls. */

export interface IndexedCaption {
  text: string;
  startMs: number;
  endMs: number;
}

/** A run of consecutive usable captions, referenced by caption index only. */
export interface Passage {
  index: number;
  first: number;
  last: number;
}

export type CountTokens = (text: string) => number;

/** Passage boundaries changed only by changing this rule. Part of the stored variant. */
export const PASSAGE_VERSION = 1;
const MAX_CAPTION_CHARACTERS = 16_000;
const SENTENCE_END = /[.!?。！？]$/u;
const MIN_PASSAGE_TOKENS = 100;
const MAX_PASSAGE_TOKENS = 160;

/** Empty and oversized captions stay at their indexes but never enter a passage. */
export function usableCaption(text: string): boolean {
  return text.trim().length > 0 && text.length <= MAX_CAPTION_CHARACTERS;
}

/**
 * The experiments counted cl100k tokens. The platform does not bundle a tokenizer, so
 * boundaries use a character estimate; they need only be approximately right.
 */
export const estimateTokens: CountTokens = text => Math.ceil(text.length / 4);

/**
 * Port of video-index `passages()`: one passage per run of usable captions, cut at a caption
 * ending in sentence punctuation once it reaches 100 tokens, forced at 160. An unusable
 * caption ends the current passage.
 */
export function buildPassages(segments: readonly IndexedCaption[], countTokens: CountTokens = estimateTokens): Passage[] {
  const passages: Passage[] = [];
  let ids: number[] = [];
  const flush = () => {
    if (ids.length) passages.push({ index: passages.length, first: ids[0]!, last: ids.at(-1)! });
    ids = [];
  };
  segments.forEach((segment, id) => {
    if (!usableCaption(segment.text)) { flush(); return; }
    ids.push(id);
    const tokens = countTokens(ids.map(i => segments[i]!.text).join(' '));
    if ((tokens >= MIN_PASSAGE_TOKENS && SENTENCE_END.test(segment.text.trimEnd())) || tokens >= MAX_PASSAGE_TOKENS) flush();
  });
  flush();
  return passages;
}

/** The passage text an embedding sees: its captions joined with spaces, no prefix. */
export function passageText(segments: readonly IndexedCaption[], passage: Pick<Passage, 'first' | 'last'>): string {
  return captionRange(passage.first, passage.last)
    .filter(id => usableCaption(segments[id]!.text))
    .map(id => segments[id]!.text.replace(/[\r\n]+/gu, ' ').trim())
    .join(' ');
}

export function captionRange(first: number, last: number): number[] {
  return Array.from({ length: Math.max(0, last - first + 1) }, (_, offset) => first + offset);
}
