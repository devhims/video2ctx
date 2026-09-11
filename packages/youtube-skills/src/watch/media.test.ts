import { describe, expect, test } from 'vitest';
import { selectCandidates } from './media';

describe('frame source selection', () => {
  const raw = { streamingData: {
    formats: [{ url: 'https://example.com/360', mimeType: 'video/mp4; codecs="avc1"', width: 640, height: 360 }],
    adaptiveFormats: [{ url: 'https://example.com/1080', mimeType: 'video/mp4; codecs="avc1"', width: 1920, height: 1080 }],
  } };
  test('retains local seekability preference by default', () => {
    expect(selectCandidates(raw, 1920)[0]?.height).toBe(360);
  });
  test('hosted extraction tries higher resolution first with a lower-resolution fallback', () => {
    expect(selectCandidates(raw, 1920, true).map(candidate => candidate.height)).toEqual([1080, 360]);
    expect(selectCandidates(raw, 1280, true).map(candidate => candidate.height)).toEqual([360]);
  });
  test('retains a progressive fallback when high-resolution adaptive formats fill the shortlist', () => {
    const candidates = selectCandidates({ streamingData: { ...raw.streamingData,
      adaptiveFormats: Array.from({ length: 5 }, (_, index) => ({
        url: `https://example.com/adaptive-${index}`, mimeType: 'video/mp4', width: 1920, height: 1080,
      })),
    } }, 1920, true);
    expect(candidates).toHaveLength(4);
    expect(candidates[0]?.height).toBe(1080);
    expect(candidates.at(-1)?.height).toBe(360);
  });
});
