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
        fetch: async () => {
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

  test('preserves missing captions after every transcript slot agrees', async () => {
    const operation = {
      kind: 'transcript', id: 'abcdefghijk', granularity: 'word',
    } satisfies YouTubeOperation;
    const missing = () => Response.json({ error: {
      code: 'NOT_FOUND', message: 'No caption track is available.', status: 404, retryable: false,
    } }, { status: 404 });
    const { env, requested } = environment([missing(), missing()]);

    await expect(runYouTubeOperation(env, operation)).rejects.toMatchObject({
      code: 'NOT_FOUND', status: 404, retryable: false,
    });
    expect(requested).toHaveLength(2);
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
    const { env } = environment([failure]);

    await expect(runYouTubeOperation(env, operation)).rejects.toEqual(
      expect.objectContaining<Partial<YouTubeProcessorError>>({
        code: 'RATE_LIMITED', status: 429, retryable: true,
      }),
    );
  });
});
