import assert from 'node:assert/strict';
import { test, beforeEach, afterEach } from 'node:test';
import { platformRequest, PlatformApiError } from './platform-request.ts';

beforeEach(() => { Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { hostname: 'example.com' }, setTimeout, clearTimeout } }); });
afterEach(() => { Reflect.deleteProperty(globalThis, 'window'); });

test('waits for the API beyond former dashboard deadlines', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  window.setTimeout = setTimeout as unknown as typeof window.setTimeout;
  window.clearTimeout = clearTimeout as unknown as typeof window.clearTimeout;
  let finish!: (response: Response) => void;
  t.mock.method(globalThis, 'fetch', (_url: unknown, init: RequestInit) => new Promise<Response>((resolve, reject) => {
    finish = resolve;
    init.signal?.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')));
  }));
  const request = platformRequest('/v1/providers/youtube/videos/video/transcript');
  t.mock.timers.tick(180_000);
  finish(Response.json({ text: 'Transcript exists' }));
  assert.deepEqual(await request, { text: 'Transcript exists' });
});

for (const status of [401, 402, 403, 404, 429, 500, 502, 504]) {
  test(`preserves API status, code and message for ${status}`, async t => {
    t.mock.method(globalThis, 'fetch', async () => Response.json({ error: { code: 'API_CODE', message: 'Exact API explanation' } }, { status }));
    await assert.rejects(platformRequest('/v1/test'), (error: unknown) => error instanceof PlatformApiError && error.status === status && error.code === 'API_CODE' && error.message === 'Exact API explanation');
  });
}

test('preserves explicit cancellation', async t => {
  const controller = new AbortController();
  t.mock.method(globalThis, 'fetch', (_url: unknown, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')));
  }));
  const request = platformRequest('/v1/test', { signal: controller.signal });
  controller.abort();
  await assert.rejects(request, { name: 'AbortError' });
});

test('identifies a lost connection without inventing an API response', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(platformRequest('/v1/test'), /connection/i);
});

test('cancellation while reading an API error remains cancellation', async t => {
  const controller = new AbortController();
  t.mock.method(globalThis, 'fetch', async () => {
    const response = new Response(null, { status: 504 });
    response.json = async () => { controller.abort(); throw new DOMException('Cancelled', 'AbortError'); };
    return response;
  });
  await assert.rejects(platformRequest('/v1/test', { signal: controller.signal }), { name: 'AbortError' });
});

test('non-JSON API errors retain HTTP status without displaying proxy HTML', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('<html>Gateway timeout</html>', { status: 504 }));
  await assert.rejects(platformRequest('/v1/test'), (error: unknown) => error instanceof PlatformApiError && error.status === 504 && error.message === 'Request failed (504).');
});
