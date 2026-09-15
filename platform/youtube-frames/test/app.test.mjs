import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFrameApp } from '../app.mjs';

const request = { videoId: 'abcdefghijk', timestampsMs: [1000] };
const post = (app, input = request) => app.request('/frames', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
});

test('validates requests before starting extraction and normalizes timestamps', async () => {
  const seen = [];
  const app = createFrameApp(async input => { seen.push(input); return { videoId: input.videoId }; });
  for (const invalid of [{ ...request, timestampsMs: [] }, { ...request, timestampsMs: [-1] },
    { ...request, timestampsMs: [1.5] }, { ...request, timestampsMs: Array(7).fill(0) },
    { ...request, extractionTimeoutMs: 0 }, { ...request, extractionTimeoutMs: 45001 },
    { ...request, maxWidth: 4000 }, { ...request, inputUrl: 'http://localhost' }, { ...request, videoId: '../foo' }]) {
    assert.equal((await post(app, invalid)).status, 422);
  }
  assert.equal(seen.length, 0);
  assert.equal((await post(app, { ...request, timestampsMs: [2000, 1000, 2000] })).status, 200);
  assert.deepEqual(seen, [{ ...request, timestampsMs: [1000, 2000], maxWidth: 1920 }]);
  assert.equal((await post(app, { ...request, extractionTimeoutMs: 15000 })).status, 200);
  assert.equal(seen[1].extractionTimeoutMs, 15000);
});

test('rejects overlapping jobs and releases capacity after failures', async () => {
  let release;
  const app = createFrameApp(() => new Promise((_, reject) => { release = reject; }));
  const pending = post(app);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  const busy = await post(app);
  assert.equal(busy.status, 503);
  assert.equal(busy.headers.get('retry-after'), '1');
  release(new Error('secret upstream URL'));
  const response = await pending;
  assert.equal(response.status, 502);
  assert.ok(!(await response.text()).includes('secret'));
  assert.equal((await (await app.request('/health')).json()).active, false);
});

test('rejects excessive bodies before extraction', async () => {
  const app = createFrameApp(() => { throw new Error('must not run'); });
  assert.equal((await post(app, { ...request, extra: 'a'.repeat(5000) })).status, 413);
});

test('logs the original failure with a correlation ID while keeping the response safe', async () => {
  const logs = [];
  const error = Object.assign(new Error('decoder failed at https://media.example/video?sig=SECRET'), {
    code: 'MEDIA_UNAVAILABLE', cause: Object.assign(new Error('connect ECONNRESET'), { code: 'ECONNRESET' }),
  });
  const app = createFrameApp(async () => { throw error; }, { log: event => logs.push(event) });
  const response = await post(app);
  assert.equal(response.status, 502);
  assert.match(response.headers.get('x-extraction-id') ?? '', /^[0-9a-f-]{36}$/);
  assert.equal(logs[0].event, 'youtube_frames_failure');
  assert.equal(logs[0].error.code, 'MEDIA_UNAVAILABLE');
  assert.equal(logs[0].error.cause.code, 'ECONNRESET');
  assert.match(logs[0].error.message, /decoder failed/);
  assert.ok(!JSON.stringify(logs).includes('SECRET'));
  assert.ok(!(await response.text()).includes('decoder'));
});
