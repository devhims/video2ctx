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
      brand: { wordmark: ['the', 'INNER', 'SCORECARD'], wordmarkTag: 'CLIPS', accent: '#E3262E', endCard: { channel: 'on The Inner Scorecard' } },
      speakers: { guest: { name: 'Joaquin', role: 'Former OpenAI' } },
      overlay: { nameTag: { speaker: 'guest', atSec: 0.5 }, cards: [{ label: 'Context', title: 'Minions', atPhrase: 'no such phrase' }] },
    });
    expect(plan.html).toContain('src="assets/S1.mp4"');
    expect(plan.html).toContain('<div class="hook-line hook-hi"><span>like the Minions</span></div>');
    expect(plan.html).toContain('--accent: #E3262E');
    expect(plan.html).toMatch(/id="name-tag" class="clip slot" data-start="3\.15"/);
    expect(plan.html).toMatch(/id="ec" class="clip" data-start="10"/);
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

  test('puts a round photo beside the hook when one is given', () => {
    const plan = buildOverlay({ id: 'S4', short, words, segments: one, durationSec: 6, videoFile: 'S4.mp4', brand: {}, speakers: {},
      overlay: { hookImage: { src: 'satya.jpg', alt: 'Satya Nadella' } }, hookImageFile: 'hook-image.jpg' });
    expect(plan.html).toContain('<img class="hook-img" src="assets/hook-image.jpg" alt="Satya Nadella" />');
    expect(plan.html).toContain('<div class="hook-row">');
    expect(plan.html).toContain('tl.from("#hook .hook-img"');
  });

  test('falls back to typical face zones per framing', () => {
    expect(typicalFaces(timelineSegments(one))[0]!.boxes).toEqual([{ x: 120, y: 380, w: 840, h: 980 }]);
  });
});

describe('end card, zooms and scenes', () => {
  const short = { spec: { id: 'S1', hook: 'Hook', cuts: [] }, cuts: [], durationMs: 20_000 } as unknown as ResolvedShort;
  const long: CaptionWord[] = [
    { text: 'they', startMs: 1_000, endMs: 1_300 }, { text: 'get', startMs: 1_300, endMs: 1_500 }, { text: 'mischievous.', startMs: 1_500, endMs: 2_200 },
    { text: 'the', startMs: 5_000, endMs: 5_200 }, { text: 'minions', startMs: 5_200, endMs: 5_700 }, { text: 'love', startMs: 5_700, endMs: 6_000 },
    { text: 'what', startMs: 9_000, endMs: 9_300 }, { text: 'the', startMs: 9_300, endMs: 9_500 }, { text: 'hell?', startMs: 9_500, endMs: 10_000 },
    { text: 'come', startMs: 16_000, endMs: 16_400 }, { text: 'on.', startMs: 16_400, endMs: 16_900 },
  ];
  const crop = [{ inMs: 0, outMs: 20_000, layout: { atMs: 0, mode: 'crop' as const, x: 0.5 } }];
  const sfx = { riser: 'sfx/riser.mp3', 'impact-bass-1': 'sfx/impact-bass-1.mp3', 'click-soft': 'sfx/click-soft.mp3', pop: 'sfx/pop.mp3', 'whoosh-short': 'sfx/whoosh-short.mp3', whoosh: 'sfx/whoosh.mp3' };
  const base = { id: 'S1', short, words: long, segments: crop, durationSec: 17, videoFile: 'S1.mp4', speakers: {} };

  test('plays the end card after the last word on a blurred freeze, with the thumbnail and its sounds', () => {
    const plan = buildOverlay({ ...base, brand: { endCard: { channel: 'on The Inner Scorecard' } }, overlay: {}, sfx,
      endCardFiles: { freeze: 'endcard/freeze.jpg', blur: 'endcard/freeze-blur.jpg', thumbnail: 'endcard/thumbnail.jpg' } });
    expect(plan.durationSec).toBe(19.8);
    expect(plan.html).toMatch(/id="root" data-composition-id="main" data-start="0" data-duration="19\.8"/);
    expect(plan.html).toMatch(/<div id="cam"><video id="a-roll"[^>]*data-duration="17"/);
    expect(plan.html).toMatch(/id="end-freeze" class="clip" src="assets\/endcard\/freeze\.jpg" alt="" data-start="17"/);
    expect(plan.html).toContain('<img src="assets/endcard/thumbnail.jpg"');
    expect(plan.html).toContain('<span>Full episode</span>');
    expect(plan.html).toContain('<span>Tap the link below</span>');
    // Riser cresting on the thumbnail's landing, impact, tap click, chip pop.
    expect(plan.html).toMatch(/src="assets\/sfx\/riser\.mp3" data-start="16\.193"[^>]*data-media-start="2\.272"/);
    expect(plan.html).toMatch(/src="assets\/sfx\/impact-bass-1\.mp3" data-start="17\.32"/);
    expect((plan.html.match(/<audio /g) ?? []).length).toBe(4);
  });

  test('shows text only without a thumbnail, and plays silent without sound files', () => {
    const plan = buildOverlay({ ...base, brand: { endCard: { cta: '' } }, overlay: {} });
    expect(plan.html).not.toContain('id="ec-thumb"');
    expect(plan.html).not.toContain('id="ec-chip"');
    expect(plan.html).not.toContain('<audio ');
  });

  test('zooms on the face for key lines, with a whoosh or a hit, and reports busy or misplaced ones', () => {
    const faces = Array.from({ length: 40 }, (_, index) => ({ atSec: index / 2, boxes: [{ x: 140, y: 400, w: 800, h: 900 }] }));
    const plan = buildOverlay({ ...base, brand: {}, faces, sfx, overlay: { zooms: [
      { atPhrase: 'get mischievous', sound: true }, { atPhrase: 'what the hell', kind: 'punch' }, { atPhrase: 'minions love', kind: 'push' },
    ] } });
    expect(plan.html).toContain('tl.set("#cam", { transformOrigin: "50.0% 40.5%" }, 1.3);');
    expect(plan.html).toContain('tl.to("#cam", { scale: 1.16, duration: 0.14, ease: "power3.out" }, 1.3);');
    expect(plan.html).toContain('tl.to("#cam", { scale: 1.22, duration: 0.12, ease: "power3.out" }, 9);');
    expect(plan.html).toMatch(/src="assets\/sfx\/whoosh-short\.mp3"/);
    expect(plan.html).toMatch(/src="assets\/sfx\/impact-bass-1\.mp3"/);
    expect(plan.issues).toEqual(expect.arrayContaining([expect.stringMatching(/comes 3\.\d s after the previous one/)]));

    const split = [{ inMs: 0, outMs: 20_000, layout: { atMs: 0, mode: 'stack' as const } }];
    const onSplit = buildOverlay({ ...base, segments: split, brand: {}, overlay: { zooms: [{ atSec: 2 }] } });
    expect(onSplit.issues).toEqual([expect.stringMatching(/split screen/)]);
    expect(onSplit.html).not.toContain('tl.to("#cam"');
  });

  test('mounts scenes in the bottom half or over the frame, with captions on the seam or low', () => {
    const plan = buildOverlay({ ...base, brand: {}, sfx, overlay: { scenes: [
      { src: 'scenes/net.html', mode: 'bottom', atPhrase: 'the minions', endPhrase: 'come on', expandAtPhrase: 'what the' },
      { src: 'scenes/cake.html', mode: 'full', atSec: 1, durationSec: 2 },
      { src: 'scenes/none.html', mode: 'full', atSec: 12, durationSec: 2 },
    ] }, sceneFiles: [{ compositionId: 'net', file: 'net.html' }, { compositionId: 'cake', file: 'cake.html' }, undefined] });
    expect(plan.html).toMatch(/<div id="net" class="scene" data-composition-id="net" data-composition-src="compositions\/net\.html" data-start="5" data-duration="11"[^>]*style="clip-path:inset\(100% 0% 0% 0%\)"/);
    expect(plan.html).toContain('tl.to("#net", { clipPath: "inset(50% 0% 0% 0%)", duration: 0.3, ease: "power3.out" }, 5);');
    expect(plan.html).toContain('tl.to("#net", { clipPath: "inset(0% 0% 0% 0%)", duration: 0.32, ease: "power2.inOut" }, 9);');
    expect(plan.html).toMatch(/id="cake"[^>]*style="clip-path:circle\(0% at 50% 40%\)"/);
    // "minions love" sits on the seam under the bottom scene; "hell?" sits low once it covers the frame.
    expect(plan.html).toMatch(/id="cap-\d+"[^>]*data-start="5"[^>]*style="top:909px/);
    expect(plan.html).toMatch(/id="cap-\d+"[^>]*data-start="9"[^>]*style="top:1422px/);
    expect(plan.issues).toEqual(expect.arrayContaining([expect.stringMatching(/scene 3: scenes\/none\.html has no data-composition-id/)]));
  });

  test('appears with a cut to a split screen, warns when it starts just after one, and can close silently', () => {
    const split = [
      { inMs: 0, outMs: 4_000, layout: { atMs: 0, mode: 'crop' as const, x: 0.5 } },
      { inMs: 4_000, outMs: 20_000, layout: { atMs: 4_000, mode: 'stack' as const } },
    ];
    const files = [{ compositionId: 'net', file: 'net.html' }];
    const onCut = buildOverlay({ ...base, segments: split, brand: {}, sfx, sceneFiles: files,
      overlay: { scenes: [{ src: 'net.html', mode: 'bottom', atSec: 4, durationSec: 5 }] } });
    expect(onCut.html).toContain('tl.set("#net", { clipPath: "inset(50% 0% 0% 0%)" }, 4);');
    expect(onCut.html).not.toContain('tl.to("#net", { clipPath: "inset(50% 0% 0% 0%)"');
    // Only the entrance whoosh by default; exits and zooms other than punch stay silent.
    expect((onCut.html.match(/<audio /g) ?? []).length).toBe(1);
    const quiet = buildOverlay({ ...base, brand: {}, sfx, sceneFiles: files,
      overlay: { zooms: [{ atSec: 1 }], scenes: [{ src: 'net.html', mode: 'full', atSec: 8, durationSec: 4, enterSound: false }] } });
    expect(quiet.html).not.toContain('<audio ');
    expect(onCut.issues.filter((issue) => /scene/.test(issue))).toEqual([]);
    const late = buildOverlay({ ...base, segments: split, brand: {}, sceneFiles: files,
      overlay: { scenes: [{ src: 'net.html', mode: 'bottom', atSec: 4.13, durationSec: 5 }] } });
    expect(late.issues.filter((issue) => /scene/.test(issue))).toEqual([expect.stringMatching(/starts 0\.13 s after the cut to a split screen.*atSec 6\).*atSec 4 /)]);
  });
});
