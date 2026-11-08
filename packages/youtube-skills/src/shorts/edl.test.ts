import { describe, expect, test } from 'vitest';

import {
  buildCues,
  captionWords,
  parseEdl,
  renderSegments,
  snapCutToSilence,
  alignCutToFrames,
  resolveShorts,
  toAss,
  toSrt,
  type Edl,
} from './edl';
import { flattenWords } from './transcript';
import { segment } from './fixtures';

const words = flattenWords([
  segment(10_000, [['so', 10_000], [' I', 10_250], [' walked', 10_500], [' into', 10_800], [' such', 11_000], [' office,', 11_300], [' uh', 11_700], [' one', 12_000], [' day.', 12_300]]),
  segment(20_000, [['>> And', 20_000], [' then', 20_300], [' he', 20_600], [' stopped', 20_900], [' me.', 21_200], [' Later', 21_500]]),
]);

function edl(overrides: Partial<Edl['shorts'][number]> = {}, top: Partial<Edl> = {}): Edl {
  return parseEdl({
    videoId: 'abcdefghijk',
    glossary: { 'such office': "Satya's office" },
    shorts: [{ id: 'S1', hook: 'Hook', cuts: [{ from: 'I walked', to: 'one day' }], ...overrides }],
    ...top,
  });
}

describe('parseEdl', () => {
  test('rejects malformed files with a pointed message', () => {
    expect(() => parseEdl({ videoId: 'x', shorts: [] })).toThrow(/non-empty shorts/);
    expect(() => parseEdl({ videoId: 'x', shorts: [{ id: 'a b', cuts: [{}] }] })).toThrow(/letters, digits/);
    expect(() => parseEdl({ videoId: 'x', shorts: [{ id: 'a', cuts: [{}] }, { id: 'a', cuts: [{}] }] })).toThrow(/twice/);
  });
});

describe('resolveShorts', () => {
  test('resolves phrases to the first word start and the end of the last word', () => {
    const { shorts, issues } = resolveShorts(words, edl({ layout: [{ atMs: 10_000, mode: 'crop', x: 0.4 }] }));
    expect(issues).toEqual([]);
    expect(shorts[0]!.cuts[0]).toEqual({ startMs: 10_250, endMs: 13_300, lastWordStartMs: 12_300, inMs: 10_200, outMs: 13_300 });
  });

  test('reports missing phrases, long shorts, and missing layout', () => {
    const { issues } = resolveShorts(words, edl({ cuts: [{ from: 'nobody said', to: 'this' }] }));
    expect(issues).toContainEqual(expect.objectContaining({ level: 'error', message: expect.stringMatching(/not found/) }));
    const long = resolveShorts(words, edl({ cuts: [{ startMs: 0, endMs: 61_000 }] }));
    expect(long.issues.map((issue) => issue.message)).toEqual(expect.arrayContaining([
      expect.stringMatching(/over the 60s target/),
      expect.stringMatching(/No layout yet/),
    ]));
    const tooLong = resolveShorts(words, edl({ cuts: [{ startMs: 0, endMs: 181_000 }] }));
    expect(tooLong.issues).toContainEqual(expect.objectContaining({ level: 'error', message: expect.stringMatching(/at most 180s/) }));
  });

  test('flags repeated audio as a teaser warning, not an error', () => {
    const { issues } = resolveShorts(words, edl({ cuts: [{ startMs: 20_000, endMs: 21_000 }, { startMs: 20_500, endMs: 21_500 }] }));
    expect(issues).toContainEqual(expect.objectContaining({ level: 'warning', message: expect.stringMatching(/teaser/) }));
  });
});

describe('captions', () => {
  test('apply the glossary, drop fillers and tags, and map onto the short timeline', () => {
    const { shorts } = resolveShorts(words, edl({ cuts: [{ from: 'I walked', to: 'one day' }, { from: 'he stopped', to: 'me' }] }));
    const caption = captionWords(words, shorts[0]!, { 'such office': "Satya's office" });
    expect(caption.map((word) => word.text).join(' ')).toBe("I walked into Satya's office, one day. he stopped me.");
    expect(caption[0]).toMatchObject({ startMs: 50 });
    // The second cut starts after the first cut's 3.1 s of media plus its own 100 ms lead-in.
    expect(caption.find((word) => word.text === 'he')).toMatchObject({ startMs: 3_200 });
  });

  test('build short cues and valid SRT and ASS', () => {
    const cues = buildCues([
      { text: 'one', startMs: 0, endMs: 300 },
      { text: 'two,', startMs: 300, endMs: 600 },
      { text: 'three', startMs: 600, endMs: 900 },
      { text: 'four', startMs: 900, endMs: 1_200 },
    ]);
    expect(cues.map((cue) => cue.text)).toEqual(['one two,', 'three four']);
    expect(toSrt(cues)).toBe('1\n00:00:00,000 --> 00:00:00,600\none two,\n\n2\n00:00:00,600 --> 00:00:01,200\nthree four\n');
    const ass = toAss(cues, 'Big {hook}');
    expect(ass).toContain('PlayResX: 1080');
    expect(ass).toContain('Dialogue: 1,0:00:00.00,0:00:03.00,Hook,,0,0,0,,Big hook');
    expect(ass).toContain('Dialogue: 0,0:00:00.60,0:00:01.20,Caption,,0,0,0,,THREE FOUR');
  });
});

describe('snapCutToSilence', () => {
  const cut = { startMs: 10_000, endMs: 13_000, lastWordStartMs: 12_400, inMs: 9_880, outMs: 13_000 };

  test('moves edges that land on sound into the nearest pause', () => {
    const { cut: snapped, notes } = snapCutToSilence(cut, [
      { startMs: 9_600, endMs: 9_850 },
      { startMs: 12_820, endMs: 12_980 },
    ], 'cuts[0]');
    expect(notes).toEqual([]);
    expect(snapped).toMatchObject({ inMs: 9_770, outMs: 12_940 });
  });

  test('keeps edges already in a pause', () => {
    const { cut: snapped } = snapCutToSilence(cut, [{ startMs: 9_700, endMs: 9_990 }, { startMs: 12_900, endMs: 13_200 }], 'cuts[0]');
    expect(snapped).toMatchObject({ inMs: 9_880, outMs: 13_000 });
  });

  test('flags edges with no pause nearby as likely clipped', () => {
    const { cut: snapped, notes } = snapCutToSilence(cut, [{ startMs: 11_000, endMs: 11_200 }], 'cuts[0]');
    expect(snapped).toEqual({ ...cut, softIn: true, softOut: true });
    expect(notes).toEqual([
      expect.stringMatching(/no pause at the start/),
      expect.stringMatching(/no pause after the last word/),
    ]);
  });
});

describe('alignCutToFrames', () => {
  test('rounds media edges to the frame grid', () => {
    const aligned = alignCutToFrames({ startMs: 0, endMs: 0, lastWordStartMs: 0, inMs: 1_010, outMs: 2_049 }, 25);
    expect(aligned).toMatchObject({ inMs: 1_000, outMs: 2_040 });
  });
});

describe('renderSegments', () => {
  test('splits cuts at layout changes and ignores changes hugging a cut edge', () => {
    const { shorts } = resolveShorts(words, edl({
      cuts: [{ startMs: 10_000, endMs: 13_000 }, { startMs: 20_000, endMs: 22_000 }],
      layout: [
        { atMs: 9_000, mode: 'crop', x: 0.4 },
        { atMs: 11_000, mode: 'stack' },
        { atMs: 12_900, mode: 'fit' },
        { atMs: 20_000, mode: 'crop', x: 0.6 },
      ],
    }, { leadInMs: 0 }));
    expect(renderSegments(shorts[0]!).map((segment) => [segment.inMs, segment.outMs, segment.layout.mode])).toEqual([
      [10_000, 11_000, 'crop'],
      [11_000, 13_000, 'stack'],
      [20_000, 22_000, 'crop'],
    ]);
  });
});
