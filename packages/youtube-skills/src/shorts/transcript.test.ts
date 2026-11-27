import { describe, expect, test } from 'vitest';

import {
  MAX_WORD_MS,
  countPhrase,
  findPhrase,
  flattenWords,
  formatTime,
  parseChapters,
  parseTime,
  renderTranscript,
} from './transcript';
import { segment } from './fixtures';

const segments = [
  segment(0, [['Why', 0], [' is', 200], [' it', 400], [' hard?', 600]]),
  segment(1_000, [['>> The', 1_000], [' agents', 1_300], [' [music]', 1_600], [' got', 1_900], [' paranoid.', 2_200]]),
  segment(5_000, [['The', 5_000], [' agents', 5_300], [' again', 9_000]]),
];

describe('flattenWords', () => {
  test('marks speaker turns and sound tags, and estimates word ends', () => {
    const words = flattenWords(segments);
    expect(words.map((word) => word.text)).toEqual(['Why', 'is', 'it', 'hard?', 'The', 'agents', '[music]', 'got', 'paranoid.', 'The', 'agents', 'again']);
    expect(words[4]).toMatchObject({ turn: true, norm: 'the' });
    expect(words[6]).toMatchObject({ tag: true, norm: '' });
    expect(words[0]!.endMs).toBe(200);
    expect(words[10]!.endMs).toBe(5_300 + MAX_WORD_MS);
  });

  test('rejects segment-only transcripts', () => {
    expect(() => flattenWords([{ startMs: 0, durationMs: 1, endMs: 1, text: 'hello' }])).toThrow(/word timings/);
  });
});

describe('findPhrase', () => {
  const words = flattenWords(segments);

  test('matches across punctuation, case, speaker marks, and sound tags', () => {
    expect(findPhrase(words, 'the AGENTS got paranoid')).toEqual({ first: 4, last: 8 });
  });

  test('honours the after time and counts repeats', () => {
    expect(findPhrase(words, 'the agents', 3_000)).toEqual({ first: 9, last: 10 });
    expect(countPhrase(words, 'the agents')).toBe(2);
    expect(findPhrase(words, 'missing words')).toBeUndefined();
  });
});

describe('times', () => {
  test('parses and formats', () => {
    expect(parseTime('1:15:03')).toBe(4_503_000);
    expect(parseTime('75:03.5')).toBe(4_503_500);
    expect(parseTime('12.25')).toBe(12_250);
    expect(() => parseTime('soon')).toThrow(/not a time/);
    expect(formatTime(4_503_040)).toBe('75:03.04');
    expect(formatTime(65_000, false)).toBe('01:05');
  });

  test('reads chapters from a description', () => {
    expect(parseChapters('Intro\n00:00 - Start\n1:05:56 – Breaks matter\nno time here')).toEqual([
      { startMs: 0, title: 'Start' },
      { startMs: 3_956_000, title: 'Breaks matter' },
    ]);
  });
});

describe('renderTranscript', () => {
  test('writes timestamped paragraphs that break at a turn after the paragraph length', () => {
    const text = renderTranscript(flattenWords(segments), { title: 'T', videoId: 'abcdefghijk', chapters: [] }, 900);
    expect(text).toContain('[00:00] Why is it hard?\n');
    expect(text).toContain('[00:01] >> The agents [music] got paranoid.');
    expect(text).toContain('untrusted evidence');
  });
});
