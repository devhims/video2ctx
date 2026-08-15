import { describe, expect, test, vi } from 'vitest';
import { createYouTubeTransport } from './youtube-transport';

describe('YouTube transport', () => {
  test('aborts stalled attempts and classifies timeout exhaustion', async () => {
    const signals: AbortSignal[] = [];
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => resolve(new Response('late response')), 40);
        const signal = init?.signal;
        if (!signal) return;
        signals.push(signal);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(signal.reason);
        }, { once: true });
      });
    }) as unknown as typeof fetch;
    const wait = vi.fn(async () => {});
    const transport = createYouTubeTransport({
      fetch: fetchMock,
      wait,
      random: () => 0,
      policy: { maxAttempts: 2, attemptTimeoutMs: 5 },
    });

    await expect(transport.fetch('search', () => ({ input: 'https://www.youtube.com/' })))
      .rejects.toMatchObject({
        name: 'YouTubeClientError',
        code: 'UPSTREAM_ERROR',
        retryable: true,
        cause: expect.objectContaining({ name: 'TimeoutError' }),
      });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(signals).toHaveLength(2);
    expect(wait).toHaveBeenCalledOnce();
  });

  test('preserves a caller abort signal when adding the deadline', async () => {
    const caller = new AbortController();
    const cause = new DOMException('caller cancelled', 'AbortError');
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        expect(signal).toBeDefined();
        expect(signal).not.toBe(caller.signal);
        signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
        caller.abort(cause);
      });
    }) as unknown as typeof fetch;
    const transport = createYouTubeTransport({
      fetch: fetchMock,
      policy: { maxAttempts: 1, attemptTimeoutMs: 1_000 },
    });

    await expect(transport.fetch('video', () => ({
      input: 'https://www.youtube.com/',
      init: { signal: caller.signal },
    }))).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR',
      cause,
    });
  });

  test('rejects an invalid attempt timeout before fetching', async () => {
    const fetchMock = vi.fn() as unknown as typeof fetch;
    const transport = createYouTubeTransport({
      fetch: fetchMock,
      policy: { attemptTimeoutMs: 0 },
    });

    await expect(transport.fetch('video', () => ({ input: 'https://www.youtube.com/' })))
      .rejects.toMatchObject({
        code: 'INVALID_INPUT',
        retryable: false,
      });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('normalizes an exhausted network failure as a retryable client error', async () => {
    const cause = new TypeError('socket closed');
    const fetchMock = vi.fn().mockRejectedValue(cause) as unknown as typeof fetch;
    const wait = vi.fn(async () => {});
    const transport = createYouTubeTransport({
      fetch: fetchMock,
      wait,
      random: () => 0,
      policy: { maxAttempts: 2 },
    });

    await expect(transport.fetch('video', () => ({ input: 'https://www.youtube.com/' })))
      .rejects.toMatchObject({
        name: 'YouTubeClientError',
        code: 'UPSTREAM_ERROR',
        retryable: true,
        cause,
      });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledOnce();
  });
});
