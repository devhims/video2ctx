import { describe, expect, it } from 'vitest';
import { bestChapter, chapterOfPassage, packEvidence, rankPassages, selectEvidence, serializedEvidence } from '../src/lib/video-index/pack';
import { buildPassages, estimateTokens, type IndexedCaption, type Passage } from '../src/lib/video-index/passages';
import { normalize } from '../src/lib/video-index/vectors';

const segments: IndexedCaption[] = Array.from({ length: 400 }, (_, index) => ({
  text: `This is caption ${index} with several spoken words${index % 6 === 5 ? '.' : ''}`,
  startMs: index * 3_000, endMs: index * 3_000 + 3_000,
}));
const passages = buildPassages(segments);
const unit = (index: number, dims = 8) => normalize(Array.from({ length: dims }, (_, i) => i === index % dims ? 1 : 0.01));

describe('evidence packer', () => {
  it('never exceeds the budget measured over serialized evidence with caption IDs', () => {
    for (const budget of [500, 1_000, 2_000, 4_000]) {
      const packed = packEvidence(segments, [...passages].reverse(), budget);
      expect(packed.evidenceTokens).toBeLessThanOrEqual(budget);
      expect(estimateTokens(serializedEvidence(segments, packed.excerpts))).toBe(packed.evidenceTokens);
      expect(serializedEvidence(segments, packed.excerpts)).toContain(`${packed.captions[0]} This is caption`);
    }
  });

  it('keeps whole passages with a two-caption lead-in, sorted by time', () => {
    const chosen = [passages[10]!, passages[3]!, passages[4]!];
    const packed = packEvidence(segments, chosen, 8_000);
    expect(packed.passages).toEqual([3, 4, 10]);
    expect(packed.excerpts[0]).toMatchObject({ first: passages[3]!.first - 2, last: passages[3]!.last });
    // A lead-in never reaches back into the previous selected passage.
    expect(packed.excerpts[1]).toMatchObject({ first: passages[4]!.first, last: passages[4]!.last });
    expect(packed.excerpts[2]!.first).toBe(passages[10]!.first - 2);
    expect(packed.captions).toEqual([...packed.captions].sort((a, b) => a - b));
  });

  it('skips a passage that does not fit and keeps trying smaller later ones', () => {
    const small: Passage = { index: 99, first: 399, last: 399 };
    const budget = packEvidence(segments, [small], 8_000).evidenceTokens;
    const packed = packEvidence(segments, [passages[0]!, passages[1]!, small], budget);
    expect(packed.passages).toEqual([99]);
    expect(packed.evidenceTokens).toBe(budget);
  });

  it('returns nothing when no passage fits', () => {
    expect(packEvidence(segments, passages.slice(0, 1), 10)).toMatchObject({ passages: [], captions: [], evidenceTokens: 0 });
    expect(() => packEvidence(segments, passages, 0)).toThrow('Invalid evidence budget');
  });
});

describe('targeted selection', () => {
  const vectors = passages.map((_, index) => unit(index));
  const chapters = [
    { index: 0, first: 0, last: 199 },
    { index: 1, first: 200, last: 399 },
  ];

  it('ranks passages by dot product, ties in time order', () => {
    const ranked = rankPassages(passages, vectors, unit(2));
    expect(ranked[0]!.passage.index % 8).toBe(2);
    const tied = ranked.filter(item => item.score === ranked[0]!.score).map(item => item.passage.first);
    expect(tied).toEqual([...tied].sort((a, b) => a - b));
    expect(() => rankPassages(passages, vectors.slice(1), unit(2))).toThrow();
  });

  it('assigns a passage to the chapter holding most of its captions and finds the best chapter vector', () => {
    expect(chapterOfPassage({ index: 0, first: 195, last: 210 }, chapters)).toBe(1);
    expect(chapterOfPassage({ index: 0, first: 190, last: 202 }, chapters)).toBe(0);
    expect(bestChapter([unit(0), unit(1)], unit(1))).toMatchObject({ index: 1 });
  });

  it('adds the chosen chapter up to half the budget, then fills from the global ranking', () => {
    const ranked = rankPassages(passages, vectors, unit(1));
    const plain = selectEvidence({ segments, ranked, budget: 2_000 });
    const withChapter = selectEvidence({ segments, ranked, budget: 2_000, chapter: chapters[1], chapters });
    expect(withChapter.evidenceTokens).toBeLessThanOrEqual(2_000);
    expect(withChapter.chapterPassages.length).toBeGreaterThan(0);
    for (const index of withChapter.chapterPassages) {
      expect(chapterOfPassage(passages[index]!, chapters)).toBe(1);
      expect(withChapter.passages).toContain(index);
    }
    const chapterShare = packEvidence(segments, withChapter.chapterPassages.map(index => passages[index]!), 2_000).evidenceTokens;
    expect(chapterShare).toBeLessThanOrEqual(1_000);
    // The chapter is added, never used as a filter.
    expect(withChapter.passages.some(index => chapterOfPassage(passages[index]!, chapters) === 0)).toBe(true);
    expect(plain.chapterPassages).toEqual([]);
  });
});
