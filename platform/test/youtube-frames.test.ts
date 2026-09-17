import { getVideoFrames, frameRequestSchema, validateFrameResponse } from '../src/lib/youtube-frames';

const request = { videoId: 'abcdefghijk', timestampsMs: [1000], maxWidth: 1920 };
export const frameFixture = {
  videoId: request.videoId,
  frames: [{ timestampMs: 1000, mimeType: 'image/jpeg' as const, width: 1920, height: 1080, imageBase64: '/9j/2Q==' }],
  failures: [], meta: { partial: false, warnings: [] },
};

describe('frame transport contract', () => {
  test('reports safe successful extraction details without adding them to frame evidence', async () => {
    const onDiagnostic = vi.fn();
    const fetch = vi.fn(async () => Response.json({ value: frameFixture, diagnostics: { version: 1, droppedEvents: 0,
      events: [{ stage: 'ffmpeg_success', profile: 'ios', timestampMs: 1000, width: 1920, height: 1080,
        sourceWidth: 1920, sourceHeight: 1080, formatId: 137, message: 'SECRET' }] } }));
    const env = { YOUTUBE_FRAMES: { idFromName: vi.fn(name => name), get: vi.fn(() => ({ fetch })) } } as unknown as Env;
    await expect(getVideoFrames(env, request, undefined, undefined, onDiagnostic)).resolves.toEqual(frameFixture);
    expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ kind: 'frames', outcome: 'success', capture: 'available' }));
    expect(onDiagnostic.mock.calls[0]![0].events[0]).toMatchObject({ formatId: 137, sourceWidth: 1920 });
    expect(JSON.stringify(onDiagnostic.mock.calls)).not.toContain('SECRET');
  });
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
    expect(await fetch.mock.calls[0]![0].json()).toEqual({ ...request, extractionTimeoutMs: 45000 });
    fetch.mockResolvedValueOnce(Response.json({ error: { code: 'MEDIA_UNAVAILABLE', message: 'Unavailable' } }, { status: 502 }));
    await expect(getVideoFrames(env, request)).rejects.toMatchObject({ code: 'MEDIA_UNAVAILABLE', status: 503 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  test('correlates a container failure without logging its untrusted response message', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const fetch = vi.fn(async (_request: Request) => Response.json({ error: {
        code: 'MEDIA_UNAVAILABLE', message: 'signed URL must not reach logs',
      } }, { status: 502 }));
      const env = { YOUTUBE_FRAMES: { idFromName: vi.fn(name => name), get: vi.fn(() => ({ fetch })) } } as unknown as Env;
      let caught: unknown;
      try { await getVideoFrames(env, request); } catch (error) { caught = error; }
      const extractionId = fetch.mock.calls[0]![0].headers.get('x-extraction-id');
      expect(extractionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(caught).toMatchObject({ details: { extractionId }, code: 'MEDIA_UNAVAILABLE' });
      expect(logged).toHaveBeenCalledWith(expect.objectContaining({
        event: 'youtube_frames_request_failure', extractionId, status: 502, errorCode: 'MEDIA_UNAVAILABLE',
      }));
      expect(JSON.stringify(logged.mock.calls)).not.toContain('signed URL');
    } finally { logged.mockRestore(); }
  });
  test('bounds transport even when the container binding does not acknowledge cancellation', async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn((_request: Request) => new Promise<Response>(() => {}));
      const env = { YOUTUBE_FRAMES: { idFromName: vi.fn(name => name), get: vi.fn(() => ({ fetch })) } } as unknown as Env;
      let failure: unknown;
      const onDiagnostic = vi.fn();
      const run = getVideoFrames(env, request, undefined, { extractionTimeoutMs: 5000 }, onDiagnostic).catch(error => { failure = error; });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(failure).toMatchObject({ code: 'FRAME_TIMEOUT' });
      await run;
      expect(fetch).toHaveBeenCalledOnce();
      expect(onDiagnostic).toHaveBeenCalledOnce();
      expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'transport_error', capture: 'unavailable', failureKind: 'timeout' }));
      expect(fetch.mock.calls[0]![0].signal.aborted).toBe(true);
    } finally { vi.useRealTimers(); }
  });
  test('tries the other slot only when the first is busy and did not start extraction', async () => {
    const fetch = vi.fn(async (_request: Request) => Response.json({ value: frameFixture }))
      .mockResolvedValueOnce(Response.json({ error: { code: 'PROCESSOR_BUSY', message: 'Busy' } }, { status: 503 }));
    const idFromName = vi.fn(name => name);
    const env = { YOUTUBE_FRAMES: { idFromName, get: vi.fn(() => ({ fetch })) } } as unknown as Env;
    const onDiagnostic = vi.fn();
    await expect(getVideoFrames(env, request, undefined, undefined, onDiagnostic)).resolves.toEqual(frameFixture);
    expect(onDiagnostic).toHaveBeenCalledTimes(2);
    expect(onDiagnostic.mock.calls[0]![0]).toMatchObject({ attempt: 1, outcome: 'fallback', capture: 'missing' });
    expect(onDiagnostic.mock.calls[1]![0]).toMatchObject({ attempt: 2, outcome: 'success', capture: 'missing' });
    expect(onDiagnostic.mock.calls[0]![0].extractionId).toBe(onDiagnostic.mock.calls[1]![0].extractionId);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(idFromName.mock.calls[0]![0]).not.toBe(idFromName.mock.calls[1]![0]);
  });
  test('cancels a stalled response body when the caller cancels', async () => {
    const cancel = vi.fn();
    const fetch = vi.fn(async () => new Response(new ReadableStream({ cancel })));
    const env = { YOUTUBE_FRAMES: { idFromName: vi.fn(name => name), get: vi.fn(() => ({ fetch })) } } as unknown as Env;
    const controller = new AbortController();
    const run = getVideoFrames(env, request, controller.signal);
    const rejected = expect(run).rejects.toThrow('User cancelled');
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    controller.abort(new Error('User cancelled'));
    await rejected;
    expect(cancel).toHaveBeenCalledOnce();
  });
});
