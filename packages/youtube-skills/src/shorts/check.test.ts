import { describe, expect, test } from 'vitest';

import { edgeHasSpeech, edgeHuggingChanges, flashShots, overlayVideoProblem } from './check';

describe('flashShots', () => {
  test('finds a one-frame shot between two changes', () => {
    expect(flashShots([9.5, 9.542, 11.6], 41)).toEqual([{ startSec: 9.5, endSec: 9.54 }]);
  });

  test('counts a change just after the start or just before the end', () => {
    expect(flashShots([0.4, 20, 40.7], 41)).toEqual([
      { startSec: 0, endSec: 0.4 },
      { startSec: 40.7, endSec: 41 },
    ]);
  });

  test('passes shots of a second or more', () => {
    expect(flashShots([9.4, 11.25, 26], 41)).toEqual([]);
  });
});

describe('edgeHuggingChanges', () => {
  test('reports a source cut 170 ms before the end of a cut', () => {
    expect(edgeHuggingChanges([160_000, 166_583], 157_083, 166_750)).toEqual([{ atMs: 166_583, edge: 'end', gapMs: 167 }]);
  });

  test('reports one just after the start and ignores the middle', () => {
    expect(edgeHuggingChanges([10_300, 15_000], 10_000, 30_000)).toEqual([{ atMs: 10_300, edge: 'start', gapMs: 300 }]);
  });
});

describe('edgeHasSpeech', () => {
  test('treats a pause as quiet and a word as speech', () => {
    expect(edgeHasSpeech(-62)).toBe(false);
    expect(edgeHasSpeech(-27)).toBe(true);
    expect(edgeHasSpeech(Number.NEGATIVE_INFINITY)).toBe(false);
  });
});

describe('overlayVideoProblem', () => {
  const cut = { durationSec: 55.54, modifiedMs: 2_000 };

  test('accepts the cut plus an end card', () => {
    expect(overlayVideoProblem({ durationSec: 58.37, modifiedMs: 3_000 }, cut)).toBeUndefined();
  });

  test('flags a video rendered before the current cut', () => {
    expect(overlayVideoProblem({ durationSec: 58.37, modifiedMs: 1_000 }, cut)).toMatch(/rendered before the current cut/);
  });

  test('flags a video rendered before its overlay project was rebuilt', () => {
    const video = { durationSec: 58.37, modifiedMs: 3_000 };
    expect(overlayVideoProblem(video, cut, { modifiedMs: 2_500 })).toBeUndefined();
    expect(overlayVideoProblem(video, cut, { modifiedMs: 4_000 })).toMatch(/rendered before its overlay project was last rebuilt/);
  });

  test('flags a video built from a longer, older cut', () => {
    expect(overlayVideoProblem({ durationSec: 59.37 + 0.2 + 3.5, modifiedMs: 3_000 }, cut)).toMatch(/runs 63\.07s/);
  });
});
