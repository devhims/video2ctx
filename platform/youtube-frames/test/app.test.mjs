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
    { ...request, maxWidth: 4000 }, { ...request, inputUrl: 'http://localhost' }, { ...request, videoId: '../foo' }]) {
    assert.equal((await post(app, invalid)).status, 422);
  }
  assert.equal(seen.length, 0);
  assert.equal((await post(app, { ...request, timestampsMs: [2000, 1000, 2000] })).status, 200);
  assert.deepEqual(seen, [{ ...request, timestampsMs: [1000, 2000], maxWidth: 1920 }]);
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
