import { createYouTubeTransport } from '../src/lib/youtube-transport';

describe('YouTube retry transport', () => {
  test('honors Retry-After and rebuilds a rate-limited request', async () => {
    const waits: number[] = [];
    const requests: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return requests.length === 1
        ? new Response('limited', { status: 429, headers: { 'retry-after': '1' } })
        : new Response('ok');
    });
    const transport = createYouTubeTransport({
      fetch: fetchMock as typeof fetch,
      wait: async (delayMs) => { waits.push(delayMs); },
      random: () => 0.5,
    });

    const response = await transport.fetch('captions', (attempt) => ({
      input: `https://youtube.test/captions?session=${attempt}`,
    }));

    expect(response.status).toBe(200);
    expect(requests).toEqual([
      'https://youtube.test/captions?session=1',
      'https://youtube.test/captions?session=2',
    ]);
    expect(waits).toEqual([1000]);
  });

  test('uses bounded exponential jitter for network and transient server failures', async () => {
    const waits: number[] = [];
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('network unavailable'))
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
      .mockResolvedValueOnce(new Response('ok'));
    const transport = createYouTubeTransport({
      fetch: fetchMock as typeof fetch,
      wait: async (delayMs) => { waits.push(delayMs); },
      random: () => 0.5,
      policy: { baseDelayMs: 200, maxDelayMs: 2000, maxAttempts: 5 },
    });

    const response = await transport.fetch('search', () => ({ input: 'https://youtube.test/search' }));

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(waits).toEqual([100, 200]);
  });

  test('does not retry permanent client errors', async () => {
    const wait = vi.fn(async () => {});
    const fetchMock = vi.fn(async () => new Response('missing', { status: 404 }));
    const transport = createYouTubeTransport({ fetch: fetchMock as typeof fetch, wait });

    const response = await transport.fetch('video', () => ({ input: 'https://youtube.test/video' }));

    expect(response.status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  test('returns the final rate-limit response after the retry budget is exhausted', async () => {
    const wait = vi.fn(async () => {});
    const fetchMock = vi.fn(async () => new Response('limited', { status: 429 }));
    const transport = createYouTubeTransport({
      fetch: fetchMock as typeof fetch,
      wait,
      policy: { maxAttempts: 3 },
    });

    const response = await transport.fetch('comments', () => ({ input: 'https://youtube.test/comments' }));

    expect(response.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
  });
});
