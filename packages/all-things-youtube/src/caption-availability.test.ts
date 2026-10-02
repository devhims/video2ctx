import { describe, expect, test, vi } from 'vitest';
import { createYouTubeClient } from './youtube-client';

function fixture(primary: unknown, desktop: unknown = primary, desktopStatus = 200) {
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).includes('/watch?')) return new Response(
      `var ytInitialPlayerResponse = ${JSON.stringify(desktop)};`, { status: desktopStatus });
    return Response.json(primary);
  });
  return { client: createYouTubeClient({ fetch, retry: { policy: { maxAttempts: 1 } } }), fetch };
}
const playable = { playabilityStatus: { status: 'OK' }, videoDetails: { videoId: 'AR1Gi3RHanE' } };
const challenged = { playabilityStatus: { status: 'LOGIN_REQUIRED', reason: 'Sign in to confirm you’re not a bot' } };

describe('caption availability classification', () => {
  test('a bot challenge is an upstream failure, not missing captions', async () => {
    const { client } = fixture(challenged);
    // The structured reason lets callers blame the connection; the code alone is ambiguous.
    await expect(client.getTranscript({ videoId: 'AR1Gi3RHanE' }))
      .rejects.toMatchObject({ code: 'UNAVAILABLE', retryable: true, reason: 'bot_challenge' });
    await expect(client.getCaptionTracks('AR1Gi3RHanE'))
      .rejects.toMatchObject({ code: 'UNAVAILABLE', retryable: true, reason: 'bot_challenge' });
  });
  test('an unavailable video carries no bot-challenge reason', async () => {
    const { client } = fixture({ playabilityStatus: { status: 'UNPLAYABLE', reason: 'This video is private.' } });
    const error = await client.getTranscript({ videoId: 'AR1Gi3RHanE' }).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: 'UNAVAILABLE' });
    expect((error as { reason?: unknown }).reason).toBeUndefined();
  });
  test('a challenged desktop lookup cannot prove missing captions', async () => {
    const { client } = fixture(playable, challenged);
    await expect(client.getTranscript({ videoId: 'AR1Gi3RHanE' }))
      .rejects.toMatchObject({ code: 'UNAVAILABLE', retryable: true, reason: 'bot_challenge' });
  });
  test('failed desktop metadata cannot prove missing captions', async () => {
    const { client } = fixture(playable, undefined, 429);
    await expect(client.getTranscript({ videoId: 'AR1Gi3RHanE' }))
      .rejects.toMatchObject({ code: 'RATE_LIMITED', status: 429, retryable: true });
  });
  test('malformed metadata is an invalid response, not missing captions', async () => {
    const { client } = fixture({});
    await expect(client.getTranscript({ videoId: 'AR1Gi3RHanE' }))
      .rejects.toMatchObject({ code: 'INVALID_RESPONSE', retryable: true });
  });
  test.each(['This is a private video', 'Sign in to confirm your age'])('preserves access restrictions: %s', async reason => {
    const { client } = fixture({ playabilityStatus: { status: 'LOGIN_REQUIRED', reason } });
    await expect(client.getTranscript({ videoId: 'AR1Gi3RHanE' }))
      .rejects.toMatchObject({ code: 'AUTH_REQUIRED', retryable: false });
  });
  test('a playable video with confirmed empty catalogs still has missing captions', async () => {
    const { client } = fixture(playable);
    await expect(client.getTranscript({ videoId: 'AR1Gi3RHanE' }))
      .rejects.toMatchObject({ code: 'CAPTIONS_UNAVAILABLE', retryable: false });
  });
  test('an earlier challenged client does not mask playable empty player and desktop catalogs', async () => {
    let playerCalls = 0;
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/watch?')) return new Response(`var ytInitialPlayerResponse = ${JSON.stringify(playable)};`);
      return Response.json(++playerCalls === 1 ? challenged : playable);
    });
    const client = createYouTubeClient({ fetch, retry: { policy: { maxAttempts: 1 } } });
    await expect(client.getTranscript({ videoId: 'AR1Gi3RHanE' }))
      .rejects.toMatchObject({ code: 'CAPTIONS_UNAVAILABLE', retryable: false });
  });
});

describe('caption availability in video metadata', () => {
  test('confirms empty catalogs without downloading captions', async () => {
    const { client, fetch } = fixture(playable);
    const video = await client.getVideo('AR1Gi3RHanE');
    expect(video.captionAvailability).toMatchObject({ status: 'unavailable', languages: [] });
    expect(Date.parse(video.captionAvailability!.checkedAt)).toBeGreaterThan(0);
    expect(fetch.mock.calls.some(([url]) => String(url).includes('/watch?'))).toBe(true);
    expect(fetch.mock.calls.every(([url]) => !String(url).includes('timedtext'))).toBe(true);
  });
  test.each([challenged, { playabilityStatus: { status: 'UNPLAYABLE', reason: 'Country restriction' } }])('restrictions remain unknown', async raw => {
    expect((await fixture(raw).client.getVideo('AR1Gi3RHanE')).captionAvailability?.status).toBe('unknown');
  });
  test('desktop failure preserves metadata with unknown caption status', async () => {
    const video = await fixture(playable, undefined, 429).client.getVideo('AR1Gi3RHanE');
    expect(video.availability.playable).toBe(true);
    expect(video.captionAvailability?.status).toBe('unknown');
  });
  const captioned = { ...playable, captions: { playerCaptionsTracklistRenderer: { captionTracks: [
    { baseUrl: 'https://www.youtube.com/api/timedtext?v=AR1Gi3RHanE', languageCode: 'en', name: { simpleText: 'English' } },
  ] } } };
  test('reuses tracks from the player response without a desktop or caption request', async () => {
    const { client, fetch } = fixture(captioned);
    expect((await client.getVideo('AR1Gi3RHanE')).captionAvailability).toMatchObject({ status: 'available', languages: ['en'] });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  test('desktop-only tracks count as available', async () => {
    expect((await fixture(playable, captioned).client.getVideo('AR1Gi3RHanE')).captionAvailability?.status).toBe('available');
  });
  test('malformed track URLs remain unknown rather than proving absence', async () => {
    const broken = { ...playable, captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ languageCode: 'en' }] } } };
    expect((await fixture(broken).client.getVideo('AR1Gi3RHanE')).captionAvailability?.status).toBe('unknown');
  });
});

test('preserves confirmed country restrictions as terminal caption errors', async () => {
  const raw = { playabilityStatus: { status: 'UNPLAYABLE', reason: 'The uploader has not made this video available in your country' } };
  await expect(fixture(raw).client.getTranscript({ videoId: 'AR1Gi3RHanE' }))
    .rejects.toMatchObject({ code: 'REGION_RESTRICTED', retryable: false });
});
test('generic unplayable videos are not mislabeled as country restrictions', async () => {
  await expect(fixture({ playabilityStatus: { status: 'UNPLAYABLE', reason: 'Video unavailable' } }).client.getTranscript({ videoId: 'AR1Gi3RHanE' }))
    .rejects.toMatchObject({ code: 'UNAVAILABLE' });
});

test('overlaps desktop and alternate caption checks while retaining first-playable metadata', async () => {
  let release!: () => void;
  const desktopStarted = new Promise<void>(resolve => { release = resolve; });
  let players = 0;
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).includes('/watch?')) {
      release();
      return new Response(`var ytInitialPlayerResponse = ${JSON.stringify(playable)};`);
    }
    if (++players === 1) return Response.json({ ...playable, videoDetails: { ...playable.videoDetails, title: 'Original title' },
      playabilityStatus: { status: 'OK', playableInEmbed: true } });
    await desktopStarted;
    return Response.json({ ...playable, videoDetails: { ...playable.videoDetails, title: 'Alternate title' },
      captions: { playerCaptionsTracklistRenderer: { captionTracks: [
        { baseUrl: 'https://www.youtube.com/api/timedtext?v=AR1Gi3RHanE', languageCode: 'en' },
      ] } } });
  });
  const video = await createYouTubeClient({ fetch }).getVideo('AR1Gi3RHanE');
  expect(video.title).toBe('Original title');
  expect(video.availability.embeddable).toBe(true);
  expect(video.captionAvailability?.status).toBe('available');
  expect(players).toBe(2);
});

test('exposes structured confirmed restrictions without guessing from a locale country allowlist', async () => {
  const confirmed = { playabilityStatus: { status: 'UNPLAYABLE', reason: 'The uploader has not made this video available in your country' } };
  expect((await fixture(confirmed).client.getVideo('AR1Gi3RHanE')).availability.restriction).toBe('region');
  const localized = { playabilityStatus: { status: 'UNPLAYABLE', reason: 'Dieses Video ist nicht verfügbar.' },
    microformat: { playerMicroformatRenderer: { availableCountries: ['US'] } } };
  // Configured locale need not match the proxy exit country. Never infer a block from it.
  const fetch = vi.fn(async () => Response.json(localized));
  const client = createYouTubeClient({ fetch, language: 'de', region: 'DE' });
  expect((await client.getVideo('AR1Gi3RHanE')).availability.restriction).toBeUndefined();
});
