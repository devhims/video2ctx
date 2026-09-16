import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import { getStoryboardWithFallback, readBoundedBytes } from '../storyboard-extractor.mjs';
import { storyboardImageFetch } from '../storyboard-images.mjs';
import { loadStoryboard } from '../storyboard.mjs';

const spec = { playabilityStatus: { status: 'OK' }, storyboards: { playerStoryboardSpecRenderer: {
  spec: 'https://i.ytimg.com/sb/abcdefghijk/L$L/$N.jpg?sigh=SECRET|16#9#6#3#2#1000#M$M#SECRET',
} } };
const webp = () => sharp({ create: { width: 48, height: 18, channels: 3, background: '#cb4433' } }).webp().toBuffer();

test('missing IOS storyboard reaches desktop WebP and returns valid JPEG with unchanged frame mapping', async () => {
  const bytes = await webp();
  const events = [];
  let players = 0;
  const fetchImpl = async input => {
    const url = String(input);
    if (url.includes('/player?')) { players++; return Response.json({ playabilityStatus: { status: players === 1 ? 'OK' : 'LOGIN_REQUIRED', reason: 'token=SECRET' } }); }
    if (url.includes('/watch?')) return new Response(`var ytInitialPlayerResponse = ${JSON.stringify(spec)};`);
    return new Response(bytes, { headers: { 'content-type': 'image/webp', 'set-cookie': 'SECRET' } });
  };
  const result = await loadStoryboard('abcdefghijk', getStoryboardWithFallback, {
    fetch: storyboardImageFetch(fetchImpl, event => events.push(event)), onDiagnostic: event => events.push(event), maxSheets: 1,
  });
  assert.equal(players, 3);
  const image = Buffer.from(result.sheets[0].imageBase64, 'base64');
  assert.equal(image[0], 255); assert.equal(image[1], 216);
  const metadata = await sharp(image).metadata();
  assert.equal(metadata.format, 'jpeg'); assert.equal(metadata.width, 48); assert.equal(metadata.height, 18);
  assert.equal(result.sheets[0].tileWidth, 16); assert.equal(result.sheets[0].frameCount, 6);
  assert.equal(result.sheets[0].firstFrameIndex, 0); assert.equal(result.sheets[0].intervalMs, 1000);
  assert.ok(events.some(event => event.profile === 'ios' && event.specState === 'missing'));
  assert.ok(events.some(event => event.profile === 'web' && event.outcome === 'success'));
  assert.ok(events.some(event => event.stage === 'image_normalized' && event.width === 48));
  assert.doesNotMatch(JSON.stringify(events), /SECRET|https:|cookie|reason/);
});

test('metadata requests do not download or normalize images and throwing diagnostics cannot break success', async () => {
  let requests = 0;
  const result = await loadStoryboard('abcdefghijk', getStoryboardWithFallback, { metadataOnly: true,
    fetch: async () => { requests++; return Response.json(spec); }, onDiagnostic: () => { throw new Error('logger down'); } });
  assert.equal(requests, 1); assert.deepEqual(result.sheets, []); assert.equal(result.manifest.totalSheets, 1);
});

test('does not retry 403 responses and reports unavailable with safe HTTP diagnostics', async () => {
  const events = []; let calls = 0;
  await assert.rejects(loadStoryboard('abcdefghijk', getStoryboardWithFallback, { metadataOnly: true,
    fetch: async () => { calls++; return new Response('secret', { status: 403 }); }, onDiagnostic: event => events.push(event) }),
    { code: 'UNAVAILABLE', retryable: true });
  assert.equal(calls, 4); assert.equal(events.filter(event => event.status === 403).length, 4);
});

test('moves to another profile when the first valid spec has an inaccessible sheet', async () => {
  let players = 0; let sheets = 0;
  const result = await loadStoryboard('abcdefghijk', getStoryboardWithFallback, {
    fetch: async input => {
      if (String(input).includes('/player?')) { players++; return Response.json(spec); }
      sheets++;
      return sheets === 1 ? new Response('', { status: 403 }) : new Response(Uint8Array.from([255, 216, 255, 217]), { headers: { 'content-type': 'image/jpeg' } });
    },
  });
  assert.equal(players, 2); assert.equal(result.sheets.length, 1);
});

test('the total deadline cancels an in-flight player request and stops fallback', async () => {
  let calls = 0;
  await assert.rejects(loadStoryboard('abcdefghijk', getStoryboardWithFallback, { metadataOnly: true, timeBudgetMs: 15,
    fetch: async (_input, init) => { calls++; return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })); },
    retry: { wait: async () => {} },
  }), { code: 'UNAVAILABLE', retryable: true });
  assert.equal(calls, 1);
});

test('bounded streaming rejects oversized bodies even without content-length and cancels the stream', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(9)); }, cancel() { cancelled = true; } }));
  await assert.rejects(readBoundedBytes(response, 8), { code: 'INVALID_RESPONSE' });
  assert.equal(cancelled, true);
});

test('WebP normalization rejects bad magic, truncated data, oversized advertised bytes, and excessive pixels', async () => {
  const huge = await sharp({ create: { width: 5000, height: 4100, channels: 3, background: 'red' } }).webp().toBuffer();
  for (const response of [new Response('not a webp', { headers: { 'content-type': 'image/webp' } }),
    new Response('RIFF1234WEBPtruncated', { headers: { 'content-type': 'image/webp' } }),
    new Response('', { headers: { 'content-type': 'image/webp', 'content-length': String(4 * 1024 * 1024 + 1) } }),
    new Response(huge, { headers: { 'content-type': 'image/webp' } })]) {
    await assert.rejects(storyboardImageFetch(async () => response)('https://image.test'), { code: 'INVALID_RESPONSE' });
  }
});

test('JPEG responses stay untouched and cancellation prevents conversion', async () => {
  const response = new Response('jpeg', { headers: { 'content-type': 'image/jpeg' } });
  assert.equal(await storyboardImageFetch(async () => response)('https://image.test'), response);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(storyboardImageFetch(async () => new Response(await webp(), { headers: { 'content-type': 'image/webp' } }))(
    'https://image.test', { signal: controller.signal }), { name: 'AbortError' });
});

test('processor runtime wires recovery and correlates safe success and failure diagnostics', async t => {
  const { createYouTubeRuntime } = await import('../runtime.mjs');
  const events = [];
  t.mock.method(console, 'info', value => events.push(JSON.parse(value)));
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return Response.json(calls === 1 ? { playabilityStatus: { status: 'OK' } } : spec);
  });
  const runtime = createYouTubeRuntime({});
  const result = await runtime.run({ kind: 'storyboard', id: 'abcdefghijk', metadataOnly: true });
  assert.equal(result.manifest.totalSheets, 1);
  assert.equal(new Set(events.map(event => event.storyboardId)).size, 1);
  assert.ok(events.every(event => event.event === 'youtube_storyboard_diagnostic' && event.videoId === 'abcdefghijk'));
  assert.ok(events.some(event => event.profile === 'ios' && event.specState === 'missing'));
  assert.ok(events.some(event => event.profile === 'android_vr' && event.outcome === 'success'));
  assert.doesNotMatch(JSON.stringify(events), /SECRET|https:|cookie|reason/);
  await assert.rejects(runtime.run({ kind: 'storyboard', id: 'abcdefghijk', maxSheets: 0 }), { code: 'INVALID_INPUT' });
  assert.equal(events.at(-1).stage, 'request');
  assert.equal(events.at(-1).code, 'INVALID_INPUT');
  assert.notEqual(events.at(-1).storyboardId, events[0].storyboardId);
});

test('retry backoff is interrupted by the operation deadline', async () => {
  let calls = 0;
  const start = Date.now();
  await assert.rejects(loadStoryboard('abcdefghijk', getStoryboardWithFallback, { metadataOnly: true, timeBudgetMs: 15,
    fetch: async () => { calls++; return new Response('', { status: 429, headers: { 'retry-after': '2' } }); },
  }), { code: 'UNAVAILABLE' });
  assert.equal(calls, 1);
  assert.ok(Date.now() - start < 1000);
});

test('invalid video identifiers never enter diagnostic logs', async t => {
  const { createYouTubeRuntime } = await import('../runtime.mjs');
  const events = [];
  t.mock.method(console, 'info', value => events.push(value));
  await assert.rejects(createYouTubeRuntime({}).run({ kind: 'storyboard', id: 'https://user:SECRET@host/private' }), { code: 'INVALID_INPUT' });
  assert.doesNotMatch(events.join(''), /SECRET|https:|private/);
});
