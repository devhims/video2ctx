import type { IndexedCaption } from './passages';

/** A sentence across caption boundaries, mapped to the captions it spans. */
export interface Sentence {
  first: number;
  last: number;
  text: string;
}

const SENTENCE_PUNCTUATION = /[.!?]/;
const SENTENCE_END = /[.!?]["')\]]*$/;
const PUNCTUATED_SHARE = 0.1;
const PUNCTUATED_WORD_CAP = 80;
const UNPUNCTUATED_WORD_CAP = 25;
const MIN_SENTENCE_WORDS = 4;

const words = (text: string) => text.replace(/>>/g, '').trim().split(/\s+/).filter(Boolean).length;

/**
 * Port of video-index `sentencesV2`. ">>" (a speaker change) is a hard break. Fragments under
 * four words join the previous sentence, never across a speaker change. The 25-word cut applies
 * only when fewer than 10% of captions contain sentence punctuation; otherwise it is 80 words.
 */
export function splitSentences(segments: readonly IndexedCaption[]): Sentence[] {
  if (!segments.length) return [];
  const punctuated = segments.filter(segment => SENTENCE_PUNCTUATION.test(segment.text)).length / segments.length >= PUNCTUATED_SHARE;
  const limit = punctuated ? PUNCTUATED_WORD_CAP : UNPUNCTUATED_WORD_CAP;
  const raw: Sentence[] = [];
  let current: Sentence | null = null;
  const flush = () => {
    if (current) raw.push(current);
    current = null;
  };
  segments.forEach((segment, index) => {
    for (const turn of segment.text.split(/(?=>>)/)) {
      if (turn.startsWith('>>')) flush();
      for (const piece of turn.split(/(?<=[.!?])\s+/)) {
        if (!piece.trim()) continue;
        if (!current) current = { first: index, last: index, text: piece };
        else { current.text += ' ' + piece; current.last = index; }
        if (SENTENCE_END.test(piece.trim()) || current.text.split(/\s+/).length >= limit) flush();
      }
    }
  });
  flush();
  const sentences: Sentence[] = [];
  for (const sentence of raw) {
    const previous = sentences.at(-1);
    if (words(sentence.text) < MIN_SENTENCE_WORDS && previous && !sentence.text.trim().startsWith('>>')) {
      previous.text += ' ' + sentence.text;
      previous.last = sentence.last;
      continue;
    }
    sentences.push({ ...sentence });
  }
  return sentences;
}
