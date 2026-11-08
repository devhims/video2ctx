import { describe, expect, test } from 'vitest';

import { buildOverlay, captionGroups, placeY, timelineSegments, typicalFaces } from './overlay';
import type { CaptionWord, ResolvedShort } from './edl';

const words: CaptionWord[] = [
  { text: 'AI', startMs: 100, endMs: 300 },
  { text: 'agents', startMs: 300, endMs: 600 },
  { text: 'are', startMs: 600, endMs: 800 },
  { text: 'minions.', startMs: 800, endMs: 1_200 },
  { text: 'They', startMs: 1_500, endMs: 1_700 },
  { text: 'bake', startMs: 4_000, endMs: 4_300 },
  { text: 'cake', startMs: 4_300, endMs: 4_700 },
];

const segments = [
  { inMs: 10_000, outMs: 12_000, layout: { atMs: 10_000, mode: 'crop' as const, x: 0.5 } },
  { inMs: 12_000, outMs: 16_000, layout: { atMs: 12_000, mode: 'stack' as const } },
];

describe('captionGroups', () => {
  test('breaks at punctuation, long pauses, and layout changes, and marks emphasis', () => {
    const groups = captionGroups(words, timelineSegments(segments), ['Minions', 'cake']);
    expect(groups.map((group) => group.words.map((word) => word.text).join(' '))).toEqual(['AI agents are', 'minions.', 'They', 'bake cake']);
    expect(groups.map((group) => group.mode)).toEqual(['crop', 'crop', 'crop', 'stack']);
    expect(groups[1]!.words[0]!.emphasis).toBe(true);
    expect(groups[3]!.words.map((word) => word.emphasis)).toEqual([false, true]);
  });

  test('emphasizes a multi-word glossary correction shown as one caption word', () => {
    const merged: CaptionWord[] = [{ text: 'Hugging Face', startMs: 0, endMs: 400 }, { text: 'later.', startMs: 400, endMs: 800 }];
    const groups = captionGroups(merged, timelineSegments(segments), ['Hugging Face']);
    expect(groups[0]!.words.map((word) => word.emphasis)).toEqual([true, false]);
    const short = { spec: { id: 'S2', cuts: [] }, cuts: [], durationMs: 20_000 } as unknown as ResolvedShort;
    const plan = buildOverlay({ id: 'S2', short, words: merged, segments, durationSec: 20, videoFile: 'S2.mp4', brand: {}, speakers: {},
      overlay: { cards: [{ label: 'Context', title: 'Hugging Face', atPhrase: 'hugging face' }] } });
    expect(plan.issues.filter((issue) => /phrase/.test(issue))).toEqual([]);
    expect(plan.html).toContain('id="card-1"');
  });

  test('holds a group through short gaps but not long ones', () => {
    const groups = captionGroups(words, timelineSegments(segments));
    expect(groups[1]!.endSec).toBe(1.5);
    expect(groups[2]!.endSec).toBe(1.8);
  });
});

describe('buildOverlay', () => {
  const short = { spec: { id: 'S1', hook: 'AI agents are | like the Minions', cuts: [] }, cuts: [], durationMs: 16_000 } as unknown as ResolvedShort;

  test('writes timed overlays with the brand and reports unmatched phrases', () => {
    const plan = buildOverlay({
      id: 'S1', short, words, segments, durationSec: 10, videoFile: 'S1.mp4',
      brand: { wordmark: ['the', 'INNER', 'SCORECARD'], wordmarkTag: 'CLIPS', accent: '#E3262E', endCard: ['Full episode'] },
      speakers: { guest: { name: 'Joaquin', role: 'Former OpenAI' } },
      overlay: { nameTag: { speaker: 'guest', atSec: 0.5 }, cards: [{ label: 'Context', title: 'Minions', atPhrase: 'no such phrase' }] },
    });
    expect(plan.html).toContain('src="assets/S1.mp4"');
    expect(plan.html).toContain('<div class="hook-line hook-hi"><span>like the Minions</span></div>');
    expect(plan.html).toContain('--accent: #E3262E');
    expect(plan.html).toMatch(/id="name-tag" class="clip slot" data-start="3\.15"/);
    expect(plan.html).toMatch(/id="end-card" class="clip" data-start="7\.6"/);
    expect(plan.html).toContain('window.__timelines["main"] = tl;');
    expect(plan.issues).toEqual(expect.arrayContaining([
      expect.stringMatching(/no such phrase/),
      expect.stringMatching(/needs atPhrase or atSec/),
    ]));
  });
});

describe('placeY', () => {
  const face = { x: 100, y: 500, w: 800, h: 900 };

  test('keeps the preferred spot when it is clear of faces', () => {
    expect(placeY(100, 300, [60, 1020], [[face]])).toEqual({ y: 300, overlap: 0 });
  });

  test('moves to the nearest clear spot when the preferred one covers a face', () => {
    expect(placeY(100, 1250, [60, 1020], [[face]])).toEqual({ y: 1404, overlap: 0 });
  });

  test('ignores faces outside the block horizontally', () => {
    expect(placeY(100, 900, [48, 90], [[face]]).overlap).toBe(0);
  });

  test('scores by average overlap, so a brief lean does not rule a spot out', () => {
    const head = { x: 0, y: 180, w: 1080, h: 1120 };
    const lean = { x: 0, y: 1300, w: 1080, h: 260 };
    // Only the band under the head is ever clear, and the lean covers it in one sample of four.
    expect(placeY(100, 1404, [60, 1020], [[head], [head], [head], [head, lean]])).toEqual({ y: 1404, overlap: 24_000 });
  });

  test('settles for the least overlap when nothing is clear', () => {
    const spot = placeY(400, 600, [60, 1020], [[{ x: 0, y: 180, w: 1080, h: 1300 }]]);
    expect(spot.y).toBe(1156);
    expect(spot.overlap).toBeGreaterThan(0);
  });
});

describe('face-aware overlay', () => {
  const short = { spec: { id: 'S1', hook: 'Hook', cuts: [] }, cuts: [], durationMs: 6_000 } as unknown as ResolvedShort;
  const one = [{ inMs: 0, outMs: 6_000, layout: { atMs: 0, mode: 'crop' as const, x: 0.5 } }];

  test('keeps headings at the top and captions low, below a close-up face', () => {
    const faces = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5].map((atSec) => ({ atSec, boxes: [{ x: 50, y: 420, w: 980, h: 900 }] }));
    const plan = buildOverlay({ id: 'S1', short, words, segments: one, durationSec: 6, videoFile: 'S1.mp4', brand: {}, speakers: {}, overlay: {}, faces });
    expect(plan.html).toMatch(/id="cap-0"[^>]*style="top:1422px/);
    expect(plan.html).toMatch(/id="hook"[^>]*style="top:236px/);
    expect(plan.issues).toEqual([]);
  });

  test('puts captions on the seam of split screens and headings below the wordmark', () => {
    const split = [{ inMs: 0, outMs: 6_000, layout: { atMs: 0, mode: 'stack' as const } }];
    const plan = buildOverlay({ id: 'S1', short, words, segments: split, durationSec: 6, videoFile: 'S1.mp4',
      brand: { wordmark: ['the', 'INNER', 'SCORECARD'] }, speakers: {}, overlay: {} });
    expect(plan.html).toMatch(/id="cap-0"[^>]*style="top:909px/);
    expect(plan.html).toMatch(/id="hook"[^>]*style="top:310px/);
  });

  test('falls back to typical face zones per framing', () => {
    expect(typicalFaces(timelineSegments(one))[0]!.boxes).toEqual([{ x: 120, y: 380, w: 840, h: 980 }]);
  });
});
