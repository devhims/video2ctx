import { describe, expect, it } from 'vitest';
import { buildPassages, estimateTokens, passageText, usableCaption } from '../src/lib/video-index/passages';
import { splitSentences } from '../src/lib/video-index/sentences';
import { decodeVector, dot, encodeVector, fromHalf, normalize, toHalf } from '../src/lib/video-index/vectors';

const caption = (text: string, index = 0) => ({ text, startMs: index * 2_000, endMs: index * 2_000 + 2_000 });
const captions = (texts: string[]) => texts.map(caption);
/** One token per word under a word counter, so boundaries are easy to read. */
const words = (text: string) => text.split(/\s+/).filter(Boolean).length;
const filler = (count: number, end = '') => `${Array.from({ length: count }, (_, i) => `w${i}`).join(' ')}${end}`;

describe('passage builder', () => {
  it('cuts at a sentence end once a passage reaches 100 tokens', () => {
    const segments = captions([filler(60), filler(30, '.'), filler(20, '.'), filler(10)]);
    expect(buildPassages(segments, words)).toEqual([
      { index: 0, first: 0, last: 2 },
      { index: 1, first: 3, last: 3 },
    ]);
  });

  it('does not cut at sentence ends before 100 tokens', () => {
    const segments = captions([filler(40, '.'), filler(40, '!'), filler(30, '?')]);
    expect(buildPassages(segments, words)).toEqual([{ index: 0, first: 0, last: 2 }]);
  });

  it('forces a cut at 160 tokens without punctuation', () => {
    const segments = captions([filler(80), filler(80), filler(10)]);
    expect(buildPassages(segments, words)).toEqual([
      { index: 0, first: 0, last: 1 },
      { index: 1, first: 2, last: 2 },
    ]);
  });

  it('accepts CJK sentence punctuation', () => {
    const segments = captions([filler(100, '。'), filler(5)]);
    expect(buildPassages(segments, words).map(passage => passage.last)).toEqual([0, 1]);
  });

  it('flushes at unusable captions, which keep their indexes but join no passage', () => {
    const segments = captions([filler(10), '   ', filler(10), 'x'.repeat(16_001), filler(10)]);
    expect(buildPassages(segments, words)).toEqual([
      { index: 0, first: 0, last: 0 },
      { index: 1, first: 2, last: 2 },
      { index: 2, first: 4, last: 4 },
    ]);
    expect(usableCaption('  ')).toBe(false);
    expect(usableCaption('x'.repeat(16_000))).toBe(true);
  });

  it('estimates tokens from characters and rebuilds passage text from captions', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
    const segments = captions(['Hello\nthere', 'world.']);
    expect(passageText(segments, { first: 0, last: 1 })).toBe('Hello there world.');
  });

  it('produces passages of roughly 100 to 160 estimated tokens on long speech', () => {
    const segments = Array.from({ length: 600 }, (_, index) => caption(`spoken words in caption number ${index}${index % 7 === 6 ? '.' : ''}`, index));
    const passages = buildPassages(segments);
    for (const passage of passages.slice(0, -1)) {
      const tokens = estimateTokens(passageText(segments, passage));
      expect(tokens).toBeGreaterThanOrEqual(100);
      expect(tokens).toBeLessThanOrEqual(160 + 12);
    }
    expect(passages.at(-1)!.last).toBe(599);
  });
});

describe('sentence splitter', () => {
  it('treats ">>" as a hard speaker break and never merges fragments across it', () => {
    const segments = captions(['>> Welcome everyone to the keynote today', 'and thank you. >> Yes.', '>> Great to be here with all of you.']);
    const sentences = splitSentences(segments);
    expect(sentences.map(sentence => sentence.text)).toEqual([
      '>> Welcome everyone to the keynote today and thank you.',
      '>> Yes.',
      '>> Great to be here with all of you.',
    ]);
    expect(sentences[0]).toMatchObject({ first: 0, last: 1 });
  });

  it('merges fragments under four words into the previous sentence', () => {
    const sentences = splitSentences(captions(['This is a complete sentence here.', 'Right.', 'And another full sentence follows now.']));
    expect(sentences.map(sentence => sentence.text)).toEqual([
      'This is a complete sentence here. Right.',
      'And another full sentence follows now.',
    ]);
  });

  it('cuts every 25 words only when captions are mostly unpunctuated', () => {
    const unpunctuated = captions(Array.from({ length: 20 }, (_, i) => `word${i} more words here`));
    // The cut is checked after each caption, so a sentence ends within one caption of 25 words.
    const cut = splitSentences(unpunctuated);
    expect(cut.length).toBeGreaterThan(2);
    expect(cut.slice(0, -1).every(sentence => sentence.text.split(/\s+/).length === 28)).toBe(true);
    const punctuated = captions([...Array.from({ length: 9 }, (_, i) => `long run ${i} of words without an end`), 'finally done.']);
    expect(splitSentences(punctuated)).toHaveLength(1);
  });

  it('maps each sentence to the captions it spans', () => {
    const sentences = splitSentences(captions(['First sentence starts here', 'and ends here. Second one', 'ends on this caption.']));
    expect(sentences).toEqual([
      { first: 0, last: 1, text: 'First sentence starts here and ends here.' },
      { first: 1, last: 2, text: 'Second one ends on this caption.' },
    ]);
  });
});

describe('vectors', () => {
  it('normalizes vectors so similarity is a dot product', () => {
    const vector = normalize([3, 4]);
    expect([...vector]).toEqual([expect.closeTo(0.6), expect.closeTo(0.8)]);
    expect(dot(vector, vector)).toBeCloseTo(1);
    expect(() => normalize([0, 0])).toThrow();
    expect(() => dot(new Float32Array(2), new Float32Array(3))).toThrow();
  });

  it('round-trips float16 values, including subnormals and signs', () => {
    for (const value of [0, -0, 1, -1, 0.5, 0.333, -0.0001, 6e-8, 65504]) {
      expect(fromHalf(toHalf(value))).toBeCloseTo(value, 3);
    }
    expect(toHalf(1)).toBe(0x3c00);
    expect(toHalf(-2)).toBe(0xc000);
  });

  it('stores vectors as base64 float16 at half the float32 size', () => {
    const vector = normalize(Array.from({ length: 4_096 }, (_, index) => Math.sin(index + 1)));
    const encoded = encodeVector(vector);
    expect(atob(encoded)).toHaveLength(8_192);
    const decoded = decodeVector(encoded, 4_096);
    expect(dot(decoded, vector)).toBeCloseTo(1, 3);
    expect(() => decodeVector(encoded, 2_048)).toThrow('wrong dimension');
  });
});
