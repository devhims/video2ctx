import { describe, expect, it, vi } from 'vitest';
import { buildIndex, passages, portions, resolveAnswer, retrieveOverview, sourceHash, transcriptSchema, validateCards, validateIndex, validateLessons, type Generate, type Transcript } from '../scripts/experimental-overview/index';

const transcript = (texts: string[]): Transcript => ({ videoId: 'SqcY0GlETPk', segments: texts.map((text, id) => ({ text, startMs: id * 2000 + 250, endMs: id * 2000 + 2000 })) });
const eachCaption = () => 160;
const generate: Generate = async request => {
  if (request.stage.startsWith('cards-')) {
    const data = request.data as { id: string; passage: string }[];
    return request.schema.parse({ cards: data.map(p => ({ id: p.id, title: 'Lesson', summary: 'Source-derived lesson.', anchorSegment: Number(p.passage.split(' ')[0]), anchorQuote: p.passage.slice(p.passage.indexOf(' ') + 1) })) });
  }
  const data = request.data as { title: string; summary: string; anchorSegment: number }[];
  return request.schema.parse({ lessons: data.slice(0, Math.min(3, data.length)) });
};
const build = (source: Transcript, fn = generate, signal = new AbortController().signal) => buildIndex({ transcript: source, model: 'test', countTokens: eachCaption, generate: fn, signal });

describe('experimental source-linked overview', () => {
  it('preserves exact caption IDs through empty and oversized gaps', () => {
    const source = transcript(['First', '', 'Middle', 'x'.repeat(16_001), 'Last']);
    expect(passages(source, () => 1)).toEqual([{ id: 'N0', start: 0, end: 0 }, { id: 'N1', start: 2, end: 2 }, { id: 'N2', start: 4, end: 4 }]);
  });
  it('uses sentence boundaries after 100 tokens and otherwise caps whole-caption passages at 160', () => {
    expect(passages(transcript(['a', 'b.', 'c', 'd', 'e']), text => text.split(' ').length * 60).map(p => [p.start, p.end])).toEqual([[0, 1], [2, 4]]);
  });
  it('does not split a long usable caption', () => {
    expect(passages(transcript(['a'.repeat(16_000)]), eachCaption)).toEqual([{ id: 'N0', start: 0, end: 0 }]);
  });
  it.each([{ texts: [] }, { texts: [''] }, { texts: ['  '] }, { texts: ['x'.repeat(16_001)] }])('rejects sources with no usable captions', ({ texts }) => {
    expect(() => passages(transcript(texts), eachCaption)).toThrow('usable passages');
  });
  it('caps the experimental build before any paid calls', async () => {
    const fn = vi.fn(generate);
    await expect(build(transcript(Array(1025).fill('a')), fn as Generate)).rejects.toThrow('1024');
    expect(fn).not.toHaveBeenCalled();
  });
  it('builds all 132 cards and reserves 18 outline slots across six portions', async () => {
    const source = transcript(Array.from({ length: 132 }, (_, i) => `Lesson ${i}.`));
    const fn = vi.fn(generate);
    const index = await build(source, fn as Generate);
    expect(fn).toHaveBeenCalledTimes(17);
    expect(index.cards).toHaveLength(132);
    expect(index.lessons).toHaveLength(18);
    expect(portions(index.cards).map(p => p.length)).toEqual([22, 22, 22, 22, 22, 22]);
    expect(index.lessons.filter(l => l.portion === 5)).toHaveLength(3);
    expect(validateIndex(JSON.parse(JSON.stringify(index)), source, eachCaption)).toEqual(index);
  });
  it('handles a short source without padding to 18 lessons', async () => {
    const index = await build(transcript(['Single lesson.']));
    expect(index.lessons).toHaveLength(1);
  });
  it('accepts preceding local introductions but rejects distant anchors', () => {
    const source = transcript(Array.from({ length: 12 }, (_, i) => `Line ${i}`));
    const card = { id: 'N0', title: 'Intro', summary: 'Lesson', anchorSegment: 2, anchorQuote: 'Line 2' };
    expect(validateCards(source, [{ id: 'N0', start: 10, end: 11 }], { cards: [card] })[0]?.anchorSegment).toBe(2);
    expect(() => validateCards(source, [{ id: 'N0', start: 11, end: 11 }], { cards: [card] })).toThrow('neighborhood');
  });
  it('never crosses an omitted-caption gap to borrow an introduction', () => {
    const source = transcript(['Intro', '', 'Lesson']);
    expect(() => validateCards(source, [{ id: 'N0', start: 2, end: 2 }], { cards: [{ id: 'N0', title: 'x', summary: 'x', anchorSegment: 0, anchorQuote: 'Intro' }] })).toThrow('neighborhood');
  });
  it('normalizes quotes only for verification and keeps exact original caption whitespace', () => {
    const source = transcript(['Don’t\n lose  accents: café.']);
    const [card] = validateCards(source, [{ id: 'N0', start: 0, end: 0 }], { cards: [{ id: 'N0', title: 'x', summary: 'x', anchorSegment: 0, anchorQuote: '0 Don’t lose accents: café.' }] });
    expect(card?.anchorQuote).toBe(source.segments[0]!.text);
  });
  it('accepts an exact consecutive quote while retaining only the original starting caption', () => {
    const source = transcript(['First caption.', 'Second caption.']);
    const result = validateCards(source, [{ id: 'N0', start: 0, end: 1 }], { cards: [{ id: 'N0', title: 'x', summary: 'x', anchorSegment: 0, anchorQuote: 'First caption. Second caption.' }] });
    expect(result[0]?.anchorQuote).toBe('First caption.');
    expect(() => validateCards(source, [{ id: 'N0', start: 0, end: 1 }], { cards: [{ id: 'N0', title: 'x', summary: 'x', anchorSegment: 0, anchorQuote: 'First caption. Invented second caption.' }] })).toThrow('complete anchor caption');
  });
  it.each(['invented', 'source'])('rejects fabricated or cropped anchor quotes: %s', anchorQuote => {
    const source = transcript(['the source caption']);
    expect(() => validateCards(source, [{ id: 'N0', start: 0, end: 0 }], { cards: [{ id: 'N0', title: 'x', summary: 'x', anchorSegment: 0, anchorQuote }] })).toThrow('complete anchor caption');
  });
  it('rejects duplicate or missing cards before reducing', async () => {
    const fn: Generate = async request => {
      const output = await generate(request);
      if (request.stage.startsWith('cards-')) return request.schema.parse({ cards: [] });
      return output;
    };
    await expect(build(transcript(['a', 'b']), fn as Generate)).rejects.toThrow();
    const source = transcript(['a', 'b']);
    const card = { id: 'N0', title: 'x', summary: 'x', anchorSegment: 0, anchorQuote: 'a' };
    expect(() => validateCards(source, passages(source, eachCaption), { cards: [card, card] })).toThrow('duplicate');
  });
  it('repairs invalid source references once and rejects a second invalid response', async () => {
    const source = transcript(['a', 'b']);
    const calls: string[] = [];
    const once: Generate = async request => {
      calls.push(request.stage);
      if (request.stage === 'cards-0') return request.schema.parse({ cards: [{ id: 'N0', title: 'x', summary: 'x', anchorSegment: 99, anchorQuote: 'a' }, { id: 'N1', title: 'x', summary: 'x', anchorSegment: 1, anchorQuote: 'b' }] });
      if (request.stage.endsWith('-repair')) return generate(request);
      return generate(request);
    };
    expect((await build(source, once)).cards).toHaveLength(2);
    expect(calls.filter(c => c.endsWith('-repair'))).toEqual(['cards-0-repair']);
    const invalid: Generate = async request => request.schema.parse({ cards: [{ id: 'N0', title: 'x', summary: 'x', anchorSegment: 99, anchorQuote: 'a' }] });
    const spy = vi.fn(invalid);
    await expect(build(transcript(['a']), spy as Generate)).rejects.toThrow('neighborhood');
    expect(spy).toHaveBeenCalledTimes(2);
  });
  it('does not retry a provider failure as a source-reference repair', async () => {
    const spy = vi.fn(async () => { throw new Error('Provider unavailable'); });
    await expect(build(transcript(['a']), spy)).rejects.toThrow('Provider unavailable');
    expect(spy).toHaveBeenCalledTimes(1);
  });
  it('rejects invented outline anchors and anchors borrowed from another portion', async () => {
    const index = await build(transcript(['a', 'b']));
    expect(() => validateLessons([index.cards[0]!], { lessons: [{ ...index.lessons[0]!, anchorSegment: 1 }] })).toThrow('another portion');
    expect(() => validateLessons([index.cards[0]!], { lessons: [{ ...index.lessons[0]!, anchorSegment: 999 }] })).toThrow('invented');
  });
  it('rejects missing outline slots', async () => {
    const index = await build(transcript(['a', 'b', 'c']));
    expect(() => validateLessons(index.cards, { lessons: index.lessons.slice(0, 2) })).toThrow('coverage slot');
  });
  it('rejects changed text, timestamps, video identity, ranges, exclusions and missing portions in persisted indexes', async () => {
    const source = transcript(Array(24).fill('text'));
    const index = await build(source);
    for (const changed of [transcript(Array(24).fill('changed')), { ...source, videoId: 'BLl32FvcdVM' }, { ...source, segments: source.segments.map(s => ({ ...s, endMs: s.endMs + 1 })) }]) {
      expect(() => validateIndex(index, changed, eachCaption)).toThrow('another transcript');
    }
    expect(() => validateIndex({ ...index, cards: index.cards.map((c, i) => i === 0 ? { ...c, end: 1 } : c) }, source, eachCaption)).toThrow('ranges');
    expect(() => validateIndex({ ...index, excludedSegments: [0] }, source, eachCaption)).toThrow('omitted');
    expect(() => validateIndex({ ...index, lessons: index.lessons.slice(0, -1) }, source, eachCaption)).toThrow('coverage');
    expect(() => retrieveOverview(index, transcript(['changed']))).toThrow('Stale');
  });
  it('exposes citable anchors without source ranges, deduplicates neighbors and resolves exact captions', async () => {
    const source = transcript(['First\n caption', 'Middle', 'Last']);
    // The mock returns flat text, which may normalize whitespace during quote verification.
    const index = await build(source);
    const selected = retrieveOverview(index, source);
    expect(selected.selectedSegments).toEqual([0, 1, 2]);
    expect(selected.summaries.every(s => !('start' in s) && !('end' in s))).toBe(true);
    expect(selected.transcript).toBe('0 First  caption\n1 Middle\n2 Last');
    const answer = resolveAnswer({ blocks: [{ text: 'Lesson', segmentId: 1 }] }, source, selected.allowedAnchors, selected.allowedAnchors);
    expect(answer.blocks[0]?.citation).toEqual({ ...source.segments[1], url: 'https://www.youtube.com/watch?v=SqcY0GlETPk&t=2' });
    expect(answer.unrepresentedAnchors).toEqual([0, 2]);
  });
  it('rejects unavailable answer IDs even when a neighboring caption exists', () => {
    const source = transcript(['a', 'b']);
    expect(() => resolveAnswer({ blocks: [{ text: 'Claim', segmentId: 1 }] }, source, [0])).toThrow('unavailable');
    expect(() => resolveAnswer({ blocks: [{ text: 'Claim', segmentId: 999 }] }, source, [999])).toThrow('unavailable');
  });
  it('stops before calls on cancellation and discards a response arriving after cancellation', async () => {
    const controller = new AbortController(); controller.abort();
    const fn = vi.fn(generate);
    await expect(build(transcript(['a']), fn as Generate, controller.signal)).rejects.toThrow();
    expect(fn).not.toHaveBeenCalled();
    const active = new AbortController();
    const cancelDuring: Generate = async request => { const value = await generate(request); active.abort(); return value; };
    await expect(build(transcript(['a']), cancelDuring, active.signal)).rejects.toThrow();
  });
  it('fingerprints normalized source content and rejects impossible caption timing', () => {
    const source = transcript(['a']);
    expect(sourceHash(source)).toBe(sourceHash({ ...source, ignored: true } as Transcript));
    expect(() => transcriptSchema.parse({ ...source, segments: [{ text: 'a', startMs: 2, endMs: 1 }] })).toThrow();
  });
});
