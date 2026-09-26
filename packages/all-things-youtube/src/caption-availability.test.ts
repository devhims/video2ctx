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
    await expect(client.getTranscript({ videoId: 'AR1Gi3RHanE' }))
      .rejects.toMatchObject({ code: 'UNAVAILABLE', retryable: true });
    await expect(client.getCaptionTracks('AR1Gi3RHanE'))
      .rejects.toMatchObject({ code: 'UNAVAILABLE', retryable: true });
  });
  test('a challenged desktop lookup cannot prove missing captions', async () => {
    const { client } = fixture(playable, challenged);
    await expect(client.getTranscript({ videoId: 'AR1Gi3RHanE' }))
      .rejects.toMatchObject({ code: 'UNAVAILABLE', retryable: true });
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
      .rejects.toMatchObject({ code: 'NOT_FOUND', retryable: false });
  });
});
