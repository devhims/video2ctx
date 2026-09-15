import { afterEach, expect, test, vi } from 'vitest';
import { fetchMediaWithRetry } from './media-retry';

afterEach(() => vi.useRealTimers());
const url = 'https://media.test/video?sig=private';
const init = () => ({ signal: new AbortController().signal, headers: { Range: 'bytes=10-20' } });

test.each([408, 425, 429, 500, 502, 503, 504])('retries HTTP %i once and releases the rejected body', async status => {
  const cancel = vi.fn();
  const rejected = new Response(new ReadableStream({ cancel }), { status, headers: { 'retry-after': '0' } });
  const success = new Response('bytes', { status: 206 });
  const fetch = vi.fn().mockResolvedValueOnce(rejected).mockResolvedValue(success);
  const options = init();
  expect(await fetchMediaWithRetry(fetch, url, options)).toBe(success);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls[1]).toEqual([url, options]);
  expect(cancel).toHaveBeenCalledOnce();
});

test.each([400, 401, 403, 404, 416])('does not retry HTTP %i', async status => {
  const response = new Response(null, { status });
  const fetch = vi.fn().mockResolvedValue(response);
  expect(await fetchMediaWithRetry(fetch, url, init())).toBe(response);
  expect(fetch).toHaveBeenCalledOnce();
});

test('honors Retry-After seconds and caps attempts at two', async () => {
  vi.useFakeTimers();
  const response = () => new Response(null, { status: 429, headers: { 'retry-after': '1' } });
  const fetch = vi.fn().mockImplementation(async () => response());
  const run = fetchMediaWithRetry(fetch, url, init());
  await vi.advanceTimersByTimeAsync(999);
  expect(fetch).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  expect((await run).status).toBe(429);
  expect(fetch).toHaveBeenCalledTimes(2);
});

test('honors Retry-After dates', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-15T00:00:00Z'));
  const fetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 503,
    headers: { 'retry-after': 'Tue, 15 Sep 2026 00:00:01 GMT' } })).mockResolvedValue(new Response('ok'));
  const run = fetchMediaWithRetry(fetch, url, init());
  await vi.advanceTimersByTimeAsync(999);
  expect(fetch).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  expect((await run).ok).toBe(true);
});

test('does not shorten a long Retry-After or start a retry outside the extraction budget', async () => {
  for (const [retryAfter, deadline] of [['30', Infinity], ['1', Date.now() + 500]] as const) {
    const response = new Response(null, { status: 429, headers: { 'retry-after': retryAfter } });
    const fetch = vi.fn().mockResolvedValue(response);
    expect(await fetchMediaWithRetry(fetch, url, init(), deadline)).toBe(response);
    expect(fetch).toHaveBeenCalledOnce();
  }
});

test('retries network errors and records the original cause', async () => {
  vi.useFakeTimers();
  const error = Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
  const fetch = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(new Response('ok'));
  const diagnostic = vi.fn();
  const run = fetchMediaWithRetry(fetch, url, init(), Infinity, diagnostic);
  await vi.advanceTimersByTimeAsync(301);
  expect((await run).ok).toBe(true);
  expect(diagnostic).toHaveBeenCalledWith(expect.objectContaining({ stage: 'media_retry', error, attempt: 1 }));
});

test('cancellation interrupts backoff without making another request', async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 429, headers: { 'retry-after': '1' } }));
  const run = fetchMediaWithRetry(fetch, url, { signal: controller.signal });
  const rejected = expect(run).rejects.toMatchObject({ name: 'AbortError' });
  await vi.advanceTimersByTimeAsync(10);
  controller.abort();
  await rejected;
  expect(fetch).toHaveBeenCalledOnce();
});

test('does not retry body failures after the response has been handed to the consumer', async () => {
  const response = new Response(new ReadableStream({ start(controller) { controller.error(new Error('stream reset')); } }));
  const fetch = vi.fn().mockResolvedValue(response);
  const result = await fetchMediaWithRetry(fetch, url, init());
  await expect(result.text()).rejects.toThrow('stream reset');
  expect(fetch).toHaveBeenCalledOnce();
});
