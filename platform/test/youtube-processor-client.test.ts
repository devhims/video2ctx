import {
  processorSlotOrder,
  runYouTubeOperation,
  YouTubeProcessorError,
  type YouTubeOperation,
} from '../src/lib/youtube-processor-client';

function environment(responses: Array<Response | Error>): { env: Env; requested: string[] } {
  const requested: string[] = [];
  const env = {
    YOUTUBE_PROCESSOR_INSTANCE_COUNT: '2',
    YOUTUBE_PROCESSOR_VERSION: 'test-v1',
    YOUTUBE_PROCESSOR_MAX_ATTEMPTS: '2',
    YOUTUBE_PROCESSOR_RETRY_BASE_MS: '0',
    YOUTUBE_PROCESSOR_TIMEOUT_MS: '5000',
    YOUTUBE_PROCESSOR: {
      idFromName: (name: string) => name,
      get: (id: string) => ({
        fetch: async (request: Request) => {
          expect(request.headers.get('x-processor-egress-slot')).toBe(id.split('-').at(-1));
          requested.push(id);
          const response = responses.shift();
          if (response instanceof Error) throw response;
          return response ?? Response.json({ error: { code: 'UNAVAILABLE', message: 'Unavailable' } }, { status: 503 });
        },
      }),
    },
  } as unknown as Env;
  return { env, requested };
}

describe('YouTube processor client', () => {
  test.each([false, true])('revisits slots in order after mixed transcript failures (missing first: %s)', async (missingFirst) => {
    const transient = () => Response.json({ error: { code: 'INVALID_RESPONSE', retryable: true } }, { status: 502 });
    const missing = () => Response.json({ error: { code: 'NOT_FOUND', retryable: false } }, { status: 404 });
    const { env, requested } = environment([
      ...(missingFirst ? [missing(), transient()] : [transient(), missing()]),
      Response.json({ value: { text: 'Recovered transcript' } }),
    ]);
    Object.assign(env, { YOUTUBE_PROCESSOR_MAX_ATTEMPTS: '3' });
    await expect(runYouTubeOperation(env, { kind: 'transcript', id: 'abcdefghijk', granularity: 'word' }))
      .resolves.toMatchObject({ text: 'Recovered transcript' });
    expect(requested).toHaveLength(3);
    expect(requested[2]).toBe(requested[0]);
  });

  test.each(['NOT_FOUND', 'UNAVAILABLE', 'UNKNOWN_UPSTREAM_ERROR', 'INVALID_PROCESSOR_RESPONSE'])('recovers on the fourth transcript call after %s errors', async (code) => {
    const failure = () => Response.json({ error: { code, retryable: false } }, { status: 404 });
    const { env, requested } = environment([failure(), failure(), failure(), Response.json({ value: { text: 'Recovered' } })]);
    Reflect.deleteProperty(env, 'YOUTUBE_PROCESSOR_MAX_ATTEMPTS');
    await expect(runYouTubeOperation(env, { kind: 'transcript', id: 'abcdefghijk', granularity: 'word' }))
      .resolves.toMatchObject({ text: 'Recovered' });
    expect(requested).toHaveLength(4);
    expect(requested[0]).not.toBe(requested[1]);
    expect(requested[2]).toBe(requested[0]);
    expect(requested[3]).toBe(requested[1]);
  });

  test('a later missing-caption response does not erase earlier upstream throttling', async () => {
    const { env, requested } = environment([
      Response.json({ error: { code: 'RATE_LIMITED', message: 'Caption request throttled', retryable: true } }, { status: 429 }),
      Response.json({ error: { code: 'NOT_FOUND', retryable: false } }, { status: 404 }),
    ]);
    await expect(runYouTubeOperation(env, { kind: 'transcript', id: 'abcdefghijk', granularity: 'word' }))
      .rejects.toMatchObject({ code: 'RATE_LIMITED', status: 429, retryable: true });
    expect(requested).toHaveLength(2);
  });

  test('does not retry a confirmed transcript access restriction', async () => {
    const { env, requested } = environment([Response.json({ error: { code: 'AUTH_REQUIRED', retryable: false } }, { status: 401 })]);
    await expect(runYouTubeOperation(env, { kind: 'transcript', id: 'abcdefghijk', granularity: 'word' }))
      .rejects.toMatchObject({ code: 'AUTH_REQUIRED', status: 401 });
    expect(requested).toHaveLength(1);
  });

  test('does not retry invalid transcript input even if marked retryable', async () => {
    const { env, requested } = environment([Response.json({ error: { code: 'INVALID_INPUT', retryable: true } }, { status: 400 })]);
    Object.assign(env, { YOUTUBE_PROCESSOR_MAX_ATTEMPTS: '4' });
    await expect(runYouTubeOperation(env, { kind: 'transcript', id: 'bad', granularity: 'word' }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(requested).toHaveLength(1);
  });

  test('returns unchanged results and captures diagnostics on both fallback and successful attempts', async () => {
    const onDiagnostic = vi.fn();
    const { env } = environment([
      Response.json({ error: { code: 'UNAVAILABLE' }, diagnostics: { version: 1, droppedEvents: 0,
        events: [{ stage: 'player', profile: 'IOS', specState: 'missing', outcome: 'skipped' }] } }, { status: 503 }),
      Response.json({ value: { sheets: [] }, diagnostics: { version: 1, droppedEvents: 0,
        events: [{ stage: 'image_normalized', inputFormat: 'webp', outputFormat: 'jpeg', width: 800, height: 450 }] } }),
    ]);
    await expect(runYouTubeOperation(env, { kind: 'storyboard', id: 'abcdefghijk' }, onDiagnostic)).resolves.toEqual({ sheets: [] });
    expect(onDiagnostic).toHaveBeenCalledTimes(2);
    const [first, second] = onDiagnostic.mock.calls.map(call => call[0]);
    expect(first).toMatchObject({ kind: 'storyboard', attempt: 1, outcome: 'fallback', status: 503, capture: 'available' });
    expect(second).toMatchObject({ attempt: 2, outcome: 'success', extractionId: first.extractionId,
      events: [{ stage: 'image_normalized', inputFormat: 'webp' }] });
    expect(first.slot).not.toBe(second.slot);
  });

  test('captures terminal failures and preserves the original error', async () => {
    const onDiagnostic = vi.fn();
    const { env } = environment([Response.json({ error: { code: 'NOT_FOUND', message: 'Missing' },
      diagnostics: { version: 1, events: [{ stage: 'request', code: 'NOT_FOUND', outcome: 'error' }], droppedEvents: 0 } }, { status: 404 })]);
    await expect(runYouTubeOperation(env, { kind: 'storyboard', id: 'abcdefghijk' }, onDiagnostic)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed', status: 404, capture: 'available' }));
  });

  test('invalid diagnostics and throwing sinks do not fail a successful extraction', async () => {
    const { env, requested } = environment([Response.json({ value: { sheets: [] }, diagnostics: { version: 99 } })]);
    const sink = vi.fn(() => { throw new Error('persistence unavailable'); });
    await expect(runYouTubeOperation(env, { kind: 'storyboard', id: 'abcdefghijk' }, sink)).resolves.toEqual({ sheets: [] });
    expect(sink).toHaveBeenCalledWith(expect.objectContaining({ capture: 'invalid' }));
    expect(requested).toHaveLength(1);
  });
  test('records timeout diagnostics when the binding ignores cancellation', async () => {
    const { env } = environment([]);
    Object.assign(env, { YOUTUBE_PROCESSOR_MAX_ATTEMPTS: '1' });
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    let signalStarted!: () => void;
    const started = new Promise<void>(resolve => { signalStarted = resolve; });
    vi.spyOn(env.YOUTUBE_PROCESSOR, 'get').mockReturnValue({ fetch: () => {
      signalStarted();
      return new Promise<Response>(() => {});
    } } as never);
    const sink = vi.fn();
    try {
      const pending = runYouTubeOperation(env, { kind: 'storyboard', id: 'abcdefghijk' }, sink);
      const rejected = expect(pending).rejects.toMatchObject({ code: 'PROCESSOR_UNAVAILABLE' });
      await started;
      controller.abort(new DOMException('Timed out', 'TimeoutError'));
      await rejected;
      expect(sink).toHaveBeenCalledTimes(1);
      expect(sink).toHaveBeenCalledWith(expect.objectContaining({
        outcome: 'transport_error', capture: 'unavailable', failureKind: 'timeout',
      }));
    } finally { timeout.mockRestore(); }
  });

  const blockedVideo = {
    id: 'abcdefghijk',
    availability: { status: 'LOGIN_REQUIRED', reason: 'Sign in to confirm you’re not a bot' },
    meta: { partial: true },
  };

  test('retries bot-challenged metadata on the other processor', async () => {
    const { env, requested } = environment([
      Response.json({ value: blockedVideo }),
      Response.json({ value: { id: 'abcdefghijk', viewCount: 404433 } }),
    ]);
    await expect(runYouTubeOperation(env, { kind: 'video', id: 'abcdefghijk' }))
      .resolves.toMatchObject({ viewCount: 404433 });
    expect(requested).toHaveLength(2);
    expect(requested[0]).not.toBe(requested[1]);
  });

  test('reports upstream unavailability when every metadata processor hits a bot challenge', async () => {
    const { env, requested } = environment([
      Response.json({ value: blockedVideo }), Response.json({ value: blockedVideo }),
    ]);
    await expect(runYouTubeOperation(env, { kind: 'video', id: 'abcdefghijk' }))
      .rejects.toMatchObject({ code: 'UNAVAILABLE', status: 503, retryable: true });
    expect(requested).toHaveLength(2);
  });

  test.each(['This is a private video', 'Sign in to confirm your age'])('preserves real video restrictions: %s', async (reason) => {
    const value = { ...blockedVideo, availability: { status: 'LOGIN_REQUIRED', reason } };
    const { env, requested } = environment([Response.json({ value })]);
    await expect(runYouTubeOperation(env, { kind: 'video', id: 'abcdefghijk' })).resolves.toEqual(value);
    expect(requested).toHaveLength(1);
  });

  test('recovers on a third attempt after both slots are challenged', async () => {
    const { env, requested } = environment([
      Response.json({ value: blockedVideo }), Response.json({ value: blockedVideo }),
      Response.json({ value: { id: 'abcdefghijk', title: 'Recovered' } }),
    ]);
    Object.assign(env, { YOUTUBE_PROCESSOR_MAX_ATTEMPTS: '3' });
    await expect(runYouTubeOperation(env, { kind: 'video', id: 'abcdefghijk' })).resolves.toMatchObject({ title: 'Recovered' });
    expect(requested).toHaveLength(3);
    expect(requested[0]).not.toBe(requested[1]);
  });

  test('honors Retry-After on a transient throttling response', async () => {
    vi.useFakeTimers();
    try {
      const { env, requested } = environment([
        Response.json({ error: { code: 'RATE_LIMITED', message: 'Slow down', retryable: true } }, { status: 429, headers: { 'Retry-After': '2' } }),
        Response.json({ value: { id: 'abcdefghijk' } }),
      ]);
      const pending = runYouTubeOperation(env, { kind: 'video', id: 'abcdefghijk' });
      await vi.advanceTimersByTimeAsync(1999);
      expect(requested).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toMatchObject({ id: 'abcdefghijk' });
      expect(requested).toHaveLength(2);
    } finally { vi.useRealTimers(); }
  });

  test('bounds metadata body reads with the same operation deadline', async () => {
    const { env, requested } = environment([new Response(new ReadableStream({ start() {} }))]);
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    try {
      const pending = runYouTubeOperation(env, { kind: 'video', id: 'abcdefghijk' });
      const rejected = expect(pending).rejects.toMatchObject({ code: 'PROCESSOR_UNAVAILABLE' });
      await new Promise(resolve => setTimeout(resolve, 0));
      controller.abort(new DOMException('Timed out', 'TimeoutError'));
      await rejected;
      expect(requested).toHaveLength(1);
      expect(timeout).toHaveBeenCalledTimes(1);
    } finally { timeout.mockRestore(); }
  });

  test('deprioritizes a recently challenged slot on subsequent reads in the same isolate', async () => {
    const { env, requested } = environment([
      Response.json({ value: blockedVideo }), Response.json({ value: { id: 'abcdefghijk' } }),
      Response.json({ value: { id: 'other-video' } }),
    ]);
    const random = vi.spyOn(crypto, 'getRandomValues').mockImplementation(array => { (array as Uint32Array).fill(0); return array; });
    try {
      await runYouTubeOperation(env, { kind: 'video', id: 'abcdefghijk' });
      await runYouTubeOperation(env, { kind: 'video', id: 'other-video' });
      expect(requested).toEqual(['test-v1-0', 'test-v1-1', 'test-v1-1']);
    } finally { random.mockRestore(); }
  });

  test('does not retry an explicit terminal upstream error even with a 503 envelope', async () => {
    const { env, requested } = environment([Response.json({ error: { code: 'NOT_FOUND', message: 'Deleted', retryable: false } }, { status: 503 })]);
    await expect(runYouTubeOperation(env, { kind: 'video', id: 'abcdefghijk' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(requested).toHaveLength(1);
  });

  test('does not restart the deadline while waiting for Retry-After', async () => {
    const { env, requested } = environment([Response.json({ error: { code: 'RATE_LIMITED', retryable: true } }, { status: 429, headers: { 'Retry-After': '60' } })]);
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    try {
      const pending = runYouTubeOperation(env, { kind: 'video', id: 'abcdefghijk' });
      const rejected = expect(pending).rejects.toMatchObject({ code: 'PROCESSOR_UNAVAILABLE' });
      await new Promise(resolve => setTimeout(resolve, 0));
      controller.abort(new DOMException('Timed out', 'TimeoutError'));
      await rejected;
      expect(requested).toHaveLength(1);
      expect(timeout).toHaveBeenCalledTimes(1);
    } finally { timeout.mockRestore(); }
  });

  test('retries non-JSON upstream throttling responses', async () => {
    const { env, requested } = environment([new Response('Too many requests', { status: 429 }), Response.json({ value: { id: 'abcdefghijk' } })]);
    await expect(runYouTubeOperation(env, { kind: 'video', id: 'abcdefghijk' })).resolves.toMatchObject({ id: 'abcdefghijk' });
    expect(requested).toHaveLength(2);
  });

  test('starts from the selected random slot and orders every fallback once', () => {
    expect(processorSlotOrder(4, 2)).toEqual([2, 3, 0, 1]);
    expect(processorSlotOrder(2, 1)).toEqual([1, 0]);
  });

  test('fails over to a different container on retryable responses', async () => {
    const operation = { kind: 'video', id: 'abcdefghijk' } satisfies YouTubeOperation;
    const { env, requested } = environment([
      Response.json({ error: { code: 'PROCESSOR_BUSY' } }, { status: 503 }),
      Response.json({ value: { id: 'abcdefghijk' } }),
    ]);

    await expect(runYouTubeOperation(env, operation)).resolves.toMatchObject({
      id: 'abcdefghijk',
    });
    expect(requested).toHaveLength(2);
    expect(requested[0]).not.toBe(requested[1]);
  });

  test('fails over when caption tracks are empty and partial', async () => {
    const operation = { kind: 'caption-tracks', id: 'abcdefghijk' } satisfies YouTubeOperation;
    const empty = {
      tracks: [], sourceTracks: [], translationLanguages: [], autoTranslationTargets: [],
      meta: { source: 'allthingsyoutube', fetchedAt: '2026-08-19T00:00:00.000Z', partial: true, warnings: [] },
    };
    const complete = {
      tracks: [{ id: 'a.en', name: 'English', languageCode: 'en', kind: 'asr', provenance: 'asr' }],
      sourceTracks: [{ id: 'a.en', name: 'English', languageCode: 'en', kind: 'asr', provenance: 'asr' }],
      translationLanguages: [], autoTranslationTargets: [],
      meta: { source: 'allthingsyoutube', fetchedAt: '2026-08-19T00:00:01.000Z', partial: false, warnings: [] },
    };
    const { env, requested } = environment([
      Response.json({ value: empty }),
      Response.json({ value: complete }),
    ]);

    await expect(runYouTubeOperation(env, operation)).resolves.toMatchObject({
      tracks: [{ id: 'a.en' }],
      meta: { partial: false },
    });
    expect(requested).toHaveLength(2);
    expect(requested[0]).not.toBe(requested[1]);
  });

  test('preserves empty caption tracks after every slot returns a partial result', async () => {
    const operation = { kind: 'caption-tracks', id: 'abcdefghijk' } satisfies YouTubeOperation;
    const empty = () => Response.json({ value: {
      tracks: [], sourceTracks: [], translationLanguages: [], autoTranslationTargets: [],
      meta: { source: 'allthingsyoutube', fetchedAt: '2026-08-19T00:00:00.000Z', partial: true, warnings: [] },
    } });
    const { env, requested } = environment([empty(), empty()]);

    await expect(runYouTubeOperation(env, operation)).resolves.toMatchObject({
      tracks: [],
      meta: { partial: true },
    });
    expect(requested).toHaveLength(2);
  });

  test('does not fail over a complete empty caption result', async () => {
    const operation = { kind: 'caption-tracks', id: 'abcdefghijk' } satisfies YouTubeOperation;
    const { env, requested } = environment([
      Response.json({ value: {
        tracks: [], sourceTracks: [], translationLanguages: [], autoTranslationTargets: [],
        meta: { source: 'allthingsyoutube', fetchedAt: '2026-08-19T00:00:00.000Z', partial: false, warnings: [] },
      } }),
      Response.json({ value: { tracks: [{ id: 'a.en' }] } }),
    ]);

    await expect(runYouTubeOperation(env, operation)).resolves.toMatchObject({
      tracks: [],
      meta: { partial: false },
    });
    expect(requested).toHaveLength(1);
  });

  test('fails over when a transcript slot reports missing captions', async () => {
    const operation = {
      kind: 'transcript', id: 'abcdefghijk', granularity: 'word',
    } satisfies YouTubeOperation;
    const { env, requested } = environment([
      Response.json({ error: {
        code: 'NOT_FOUND', message: 'No caption track is available.', status: 404, retryable: false,
      } }, { status: 404 }),
      Response.json({ value: {
        videoId: 'abcdefghijk',
        track: { id: 'a.en', name: 'English', languageCode: 'en', kind: 'asr', provenance: 'asr' },
        segments: [], granularity: 'word', text: 'Recovered transcript',
        meta: { source: 'allthingsyoutube', fetchedAt: '2026-08-19T00:00:01.000Z', partial: false, warnings: [] },
      } }),
    ]);

    await expect(runYouTubeOperation(env, operation)).resolves.toMatchObject({
      videoId: 'abcdefghijk',
      text: 'Recovered transcript',
    });
    expect(requested).toHaveLength(2);
    expect(requested[0]).not.toBe(requested[1]);
  });

  test('preserves missing captions only after exhausting four calls', async () => {
    const operation = {
      kind: 'transcript', id: 'abcdefghijk', granularity: 'word',
    } satisfies YouTubeOperation;
    const missing = () => Response.json({ error: {
      code: 'NOT_FOUND', message: 'No caption track is available.', status: 404, retryable: false,
    } }, { status: 404 });
    const { env, requested } = environment([missing(), missing(), missing(), missing()]);
    Object.assign(env, { YOUTUBE_PROCESSOR_MAX_ATTEMPTS: '4' });

    await expect(runYouTubeOperation(env, operation)).rejects.toMatchObject({
      code: 'NOT_FOUND', status: 404, retryable: false,
    });
    expect(requested).toHaveLength(4);
    expect(requested[2]).toBe(requested[0]);
    expect(requested[3]).toBe(requested[1]);
  });

  test('does not fail over unrelated not-found errors', async () => {
    const operation = { kind: 'video', id: 'abcdefghijk' } satisfies YouTubeOperation;
    const { env, requested } = environment([
      Response.json({ error: {
        code: 'NOT_FOUND', message: 'Video not found.', status: 404, retryable: false,
      } }, { status: 404 }),
      Response.json({ value: { id: 'abcdefghijk' } }),
    ]);

    await expect(runYouTubeOperation(env, operation)).rejects.toMatchObject({
      code: 'NOT_FOUND', status: 404,
    });
    expect(requested).toHaveLength(1);
  });

  test('preserves structured processor errors', async () => {
    const operation = { kind: 'video', id: 'abcdefghijk' } satisfies YouTubeOperation;
    const failure = Response.json({ error: {
      code: 'RATE_LIMITED', message: 'YouTube rate limited the request.', status: 429, retryable: true,
    } }, { status: 429 });
    const { env } = environment([failure, failure.clone()]);

    await expect(runYouTubeOperation(env, operation)).rejects.toEqual(
      expect.objectContaining<Partial<YouTubeProcessorError>>({
        code: 'RATE_LIMITED', status: 429, retryable: true,
      }),
    );
  });
});
