import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { createYouTubeRuntime } from '../runtime.mjs';
import { createProcessorApp } from '../app.mjs';
const require = createRequire(import.meta.url);
const youtube = require('all-things-youtube');

test('transcript runtime forwards bounded retry diagnostics on success and failure without signed URLs', async () => {
  const original = youtube.getTranscript;
  try {
    for (const fail of [false, true]) {
      youtube.getTranscript = async options => {
        assert.equal(options.videoId, 'AR1Gi3RHanE');
        assert.equal(options.lang, 'en');
        options.retry.onRetry({ operation: 'captions', attempt: 1, maxAttempts: 2, delayMs: 100,
          reason: 'preparation', code: 'INVALID_RESPONSE' });
        if (fail) throw Object.assign(new Error('private upstream URL'), { code: 'INVALID_RESPONSE', retryable: true });
        return { text: 'private transcript', segments: [] };
      };
      const app = createProcessorApp(createYouTubeRuntime({}));
      const response = await app.request('/operations', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'transcript', id: 'AR1Gi3RHanE', lang: 'en', granularity: 'word' }) });
      const body = await response.json();
      assert.equal(response.status, fail ? 502 : 200);
      assert.equal(body.diagnostics.events[0].stage, 'caption_metadata');
      assert.equal(body.diagnostics.events[0].code, 'INVALID_RESPONSE');
      assert.equal(body.diagnostics.events[0].attempt, 1);
      assert.equal(body.diagnostics.events.at(-1).outcome, fail ? 'error' : 'success');
      assert.equal(JSON.stringify(body.diagnostics).includes('private'), false);
      if (fail) assert.equal(body.error.retryable, true);
    }
  } finally { youtube.getTranscript = original; }
});

test('published extraction library reports bot-blocked metadata as upstream unavailability through the processor', async t => {
  t.mock.method(Math, 'random', () => 0);
  const requests = [];
  t.mock.method(globalThis, 'fetch', async input => {
    const url = String(input);
    requests.push(url);
    const player = { playabilityStatus: { status: 'LOGIN_REQUIRED', reason: "Sign in to confirm you're not a bot" } };
    return url.includes('/watch?') ? new Response(`var ytInitialPlayerResponse = ${JSON.stringify(player)};`) : Response.json(player);
  });
  const app = createProcessorApp(createYouTubeRuntime({}));
  const response = await app.request('/operations', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'transcript', id: 'AR1Gi3RHanE', granularity: 'segment' }) });
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.equal(body.error.code, 'UNAVAILABLE');
  assert.equal(body.error.retryable, true);
  assert.equal(body.diagnostics.events.at(-1).code, 'UNAVAILABLE');
  assert.ok(body.diagnostics.events.some(event => event.stage === 'caption_metadata' && event.status === 200));
  assert.ok(requests.every(url => url.includes('/player') || url.includes('/watch?')));
});
