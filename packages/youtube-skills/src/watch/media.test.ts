import { describe, expect, test } from 'vitest';
import { loadMediaCandidateGroup, selectCandidates } from './media';

describe('frame source selection', () => {
  const raw = { streamingData: {
    formats: [{ url: 'https://example.com/360', mimeType: 'video/mp4; codecs="avc1"', width: 640, height: 360 }],
    adaptiveFormats: [{ url: 'https://example.com/1080', mimeType: 'video/mp4; codecs="avc1"', width: 1920, height: 1080 }],
  } };
  test('retains local seekability preference by default', () => {
    expect(selectCandidates(raw, 1920)[0]?.height).toBe(360);
  });
  test('explicit resolution preference retains a lower-resolution fallback', () => {
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


test('retains the player rejection before skipping a client', async () => {
  const events: unknown[] = [];
  const group = await loadMediaCandidateGroup(0, 'abcdefghijk', 1920, {
    fetch: async () => Response.json({ playabilityStatus: { status: 'LOGIN_REQUIRED', reason: 'Sign in to confirm your age' } }),
  }, false, event => events.push(event));
  expect(group).toBeUndefined();
  expect(events).toEqual([
    expect.objectContaining({ stage: 'player_response', profile: 'ios', playabilityStatus: 'LOGIN_REQUIRED', reason: 'Sign in to confirm your age' }),
    expect.objectContaining({ stage: 'player', error: expect.objectContaining({ code: 'AUTH_REQUIRED' }) }),
  ]);
});

test('prefers itag 18 over larger progressive and adaptive streams by default', () => {
  const raw = { streamingData: { formats: [
    { itag: 22, url: 'https://example.com/720', mimeType: 'video/mp4', width: 1280 },
    { itag: 18, url: 'https://example.com/360', mimeType: 'video/mp4', width: 640 },
  ] } };
  expect(selectCandidates(raw, 1920)[0]?.formatId).toBe(18);
  expect(selectCandidates(raw, 1920, true)[0]?.formatId).toBe(22);
});

test.each([true, false, undefined])('keeps the player live flag %s with its media candidates', async live => {
  const group = await loadMediaCandidateGroup(1, 'abcdefghijk', 1280, {
    fetch: async () => Response.json({playabilityStatus:{status:'OK'},videoDetails:{isLiveContent:live},
      streamingData:{formats:[{url:'https://example.com/video',mimeType:'video/mp4',width:640}]}}),
  });
  expect(group?.isLive).toBe(live);
});
