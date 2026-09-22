import { describe, expect, test, vi } from 'vitest';
import { createYouTubeClient } from './youtube-client';

const track = (baseUrl: unknown, languageCode = 'en') => ({ baseUrl, languageCode, vssId: `.${languageCode}`, name: { simpleText: languageCode } });
const player = (tracks: unknown[]) => ({ playabilityStatus: { status: 'OK' }, captions: { playerCaptionsTracklistRenderer: { captionTracks: tracks } } });
function fixture(catalog: (n: number) => unknown[], desktop?: unknown[]) {
  let players = 0;
  const captions: string[] = [];
  const onRetry = vi.fn();
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/youtubei/v1/player')) return Response.json(player(catalog(++players)));
    if (url.includes('/watch?')) return new Response(desktop ? `var ytInitialPlayerResponse = ${JSON.stringify(player(desktop))};` : '', { status: desktop ? 200 : 404 });
    captions.push(url);
    return Response.json({ events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'Recovered transcript' }] }] });
  });
  const client = createYouTubeClient({ fetch, retry: { policy: { maxAttempts: 2 }, wait: async () => {}, onRetry } });
  return { client, captions, fetch, onRetry, playerCalls: () => players };
}

describe('caption metadata recovery', () => {
  test.each(['not-a-url', undefined, '', 'javascript:alert(1)', 'https://captions.test/\u200ben'])('recovers unusable URL %s from another player response', async bad => {
    const f = fixture(n => [track(n === 1 ? bad : 'https://captions.test/en')]);
    const result = await f.client.getTranscript({ videoId: 'AR1Gi3RHanE', language: 'en' });
    expect(result.segments[0]?.text).toBe('Recovered transcript');
    expect(f.playerCalls()).toBeGreaterThan(1);
    expect(f.captions).toEqual(['https://captions.test/en?fmt=json3']);
  });

  test('uses a valid desktop URL when the primary track with the same ID is malformed', async () => {
    const f = fixture(() => [track('broken')], [track('https://captions.test/en')]);
    expect((await f.client.getTranscript({ videoId: 'AR1Gi3RHanE', language: 'en' })).segments).toHaveLength(1);
    expect(f.captions).toEqual(['https://captions.test/en?fmt=json3']);
  });

  test('refreshes metadata without substituting another language', async () => {
    const f = fixture(n => [track(n === 1 ? 'broken' : 'https://captions.test/en'), track('https://captions.test/fr', 'fr')]);
    const result = await f.client.getTranscript({ videoId: 'AR1Gi3RHanE', language: 'en' });
    expect(result.track.languageCode).toBe('en');
    expect(f.captions).toEqual(['https://captions.test/en?fmt=json3']);
    expect(f.onRetry).toHaveBeenCalledWith(expect.objectContaining({ operation: 'captions', reason: 'preparation', code: 'INVALID_RESPONSE' }));
  });

  test('exhaustion is bounded, retryable, and contains no signed URL', async () => {
    const bad = 'broken?token=private';
    const f = fixture(() => [track(bad), track('https://captions.test/fr', 'fr')]);
    let failure: unknown;
    try { await f.client.getTranscript({ videoId: 'AR1Gi3RHanE', language: 'en' }); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: 'INVALID_RESPONSE', retryable: true });
    expect(String(failure)).not.toContain(bad);
    expect(f.playerCalls()).toBe(2);
    expect(f.onRetry).toHaveBeenCalledTimes(1);
    expect(f.captions).toHaveLength(0);
  });

  test('does not silently substitute a language absent from the catalog', async () => {
    const f = fixture(() => [track('https://captions.test/fr', 'fr')]);
    await expect(f.client.getTranscript({ videoId: 'AR1Gi3RHanE', language: 'en' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(f.captions).toHaveLength(0);
  });

  test('preserves the public desired-output-language behavior while refreshing a native track', async () => {
    const f = fixture(n => [track(n === 1 ? 'broken' : 'https://captions.test/en'), track('https://captions.test/fr', 'fr')]);
    const result = await f.client.getTranscript({ videoId: 'AR1Gi3RHanE', translateTo: 'en' });
    expect(result.track.languageCode).toBe('en');
    expect(f.captions).toEqual(['https://captions.test/en?fmt=json3']);
  });

  test('a missing URL in an existing requested track is retryable rather than captionless', async () => {
    const f = fixture(() => [track(undefined), track('https://captions.test/fr', 'fr')]);
    await expect(f.client.getTranscript({ videoId: 'AR1Gi3RHanE', language: 'en' })).rejects.toMatchObject({ code: 'INVALID_RESPONSE', retryable: true });
    expect(f.playerCalls()).toBe(2);
    expect(f.captions).toHaveLength(0);
  });

  test('does not advertise unusable caption tracks as available', async () => {
    const f = fixture(() => [track(undefined), track('https://captions.test/fr', 'fr')]);
    const result = await f.client.getCaptionTracks('AR1Gi3RHanE');
    expect(result.tracks.map(t => t.languageCode)).toEqual(['fr']);
    expect(result.defaultTrackId).toBe('.fr');
    expect(result.tracks[0]?.isDefault).toBe(true);
    expect(result.meta.partial).toBe(true);
  });

  test('invalid caller input stays terminal without making requests', async () => {
    const f = fixture(() => [track('https://captions.test/en')]);
    await expect(f.client.getTranscript({ videoId: 'invalid' })).rejects.toMatchObject({ code: 'INVALID_INPUT', retryable: false });
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.onRetry).not.toHaveBeenCalled();
  });
});
