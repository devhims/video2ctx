import { getVideoFrames, frameRequestSchema, validateFrameResponse } from '../src/lib/youtube-frames';

const request = { videoId: 'abcdefghijk', timestampsMs: [1000], maxWidth: 1920 };
export const frameFixture = {
  videoId: request.videoId,
  frames: [{ timestampMs: 1000, mimeType: 'image/jpeg' as const, width: 1920, height: 1080, imageBase64: '/9j/2Q==' }],
  failures: [], meta: { partial: false, warnings: [] },
};

describe('frame transport contract', () => {
  test('rejects seconds fractions, empty selections, extra controls and excessive frames', () => {
    for (const input of [{ ...request, timestampsMs: [1.5] }, { ...request, timestampsMs: [] },
      { ...request, timestampsMs: Array(7).fill(1) }, { ...request, inputUrl: 'http://localhost' }]) {
      expect(frameRequestSchema.safeParse(input).success).toBe(false);
    }
  });
  test('requires every requested timestamp exactly once and validates dimensions', () => {
    expect(validateFrameResponse(request, frameFixture)).toEqual(frameFixture);
    for (const value of [{ ...frameFixture, videoId: 'zyxwvutsrqp' },
      { ...frameFixture, frames: [...frameFixture.frames, ...frameFixture.frames] },
      { ...frameFixture, frames: [{ ...frameFixture.frames[0], timestampMs: 2000 }] },
      { ...frameFixture, frames: [{ ...frameFixture.frames[0], width: 1921 }] },
      { ...frameFixture, frames: [{ ...frameFixture.frames[0], imageBase64: 'https://signed-media-url' }] }]) {
      expect(() => validateFrameResponse(request, value)).toThrow();
    }
    expect(() => validateFrameResponse({ ...request, timestampsMs: [1000, 2000] }, frameFixture)).toThrow();
  });
  test('allows explicit partial coverage', () => {
    expect(validateFrameResponse({ ...request, timestampsMs: [1000, 2000] }, { ...frameFixture,
      failures: [{ timestampMs: 2000, code: 'MEDIA_UNAVAILABLE', message: 'Unavailable', retryable: true }],
      meta: { partial: true, warnings: ['Missing frame'] },
    }).failures).toHaveLength(1);
  });
  test('uses the dedicated binding, normalizes duplicates, and never retries extraction failures', async () => {
    const fetch = vi.fn(async (_request: Request) => Response.json({ value: frameFixture }));
    const env = { YOUTUBE_FRAMES: { idFromName: vi.fn(name => name), get: vi.fn(() => ({ fetch })) } } as unknown as Env;
    await expect(getVideoFrames(env, { ...request, timestampsMs: [1000, 1000] })).resolves.toEqual(frameFixture);
    expect(await fetch.mock.calls[0]![0].json()).toEqual(request);
    fetch.mockResolvedValueOnce(Response.json({ error: { code: 'MEDIA_UNAVAILABLE', message: 'Unavailable' } }, { status: 502 }));
    await expect(getVideoFrames(env, request)).rejects.toMatchObject({ code: 'MEDIA_UNAVAILABLE', status: 503 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  test('tries the other slot only when the first is busy and did not start extraction', async () => {
    const fetch = vi.fn(async (_request: Request) => Response.json({ value: frameFixture }))
      .mockResolvedValueOnce(Response.json({ error: { code: 'PROCESSOR_BUSY', message: 'Busy' } }, { status: 503 }));
    const idFromName = vi.fn(name => name);
    const env = { YOUTUBE_FRAMES: { idFromName, get: vi.fn(() => ({ fetch })) } } as unknown as Env;
    await expect(getVideoFrames(env, request)).resolves.toEqual(frameFixture);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(idFromName.mock.calls[0]![0]).not.toBe(idFromName.mock.calls[1]![0]);
  });
});
