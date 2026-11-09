import type { TranscriptSegment } from 'all-things-youtube';

/** Build a word-timed transcript segment from [text, startMs] pairs. Test-only. */
export function segment(startMs: number, words: Array<[string, number]>): TranscriptSegment {
  return {
    startMs,
    durationMs: 4_000,
    endMs: startMs + 4_000,
    text: words.map(([text]) => text).join(''),
    words: words.map(([text, at]) => ({ text, startMs: at, offsetMs: at - startMs })),
  };
}
