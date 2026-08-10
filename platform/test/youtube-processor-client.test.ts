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
