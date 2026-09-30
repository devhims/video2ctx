import { Miniflare } from 'miniflare';
import assert from 'node:assert/strict';

const run = {
  sessionId: '00000000-0000-4000-8000-000000000001',
  runId: '00000000-0000-4000-8000-000000000002',
};
const calls = [];
const mf = new Miniflare({
  modules: true,
  scriptPath: './dist/index.js',
  compatibilityDate: '2026-08-08',
  bindings: { CHECKS_ENABLED: 'true', VIDEO2CTX_API_KEY: 'test-only' },
  durableObjects: { SMOKE_GUARD: { className: 'SmokeGuard', useSQLite: true } },
  // Intercept ALL outbound traffic. This never calls production, even on unexpected URLs.
  outboundService: async request => {
    assert.equal(new URL(request.url).origin, 'https://api.video2ctx.dev');
    calls.push(request.url);
    let result;
    if (request.url.includes('/transcript?')) {
      result = { videoId: 'dQw4w9WgXcQ', text: 'mock', segments: [{ text: 'mock', startMs: 0 }] };
    } else if (request.url.endsWith('/access')) {
      result = { enabled: true };
    } else if (request.method === 'POST') {
      result = run;
    } else {
      result = { ...run, status: 'completed', result: {
        outcome: 'answered', answer: 'Mock [1]',
        sources: [{ id: '1', videoId: 'dQw4w9WgXcQ' }],
        evidence: [{ sourceId: '1', id: 'transcript:dQw4w9WgXcQ:0:0' }],
      } };
    }
    return new Response(JSON.stringify(result), {
      status: request.method === 'POST' ? 202 : 200,
      headers: { 'Content-Type': 'application/json' },
    });
  },
});
try {
  const worker = await mf.getWorker();
  const first = await worker.scheduled({ scheduledTime: 1000, cron: '0 * * * *' });
  assert.equal(first.outcome, 'ok');
  const duplicate = await worker.scheduled({ scheduledTime: 1000, cron: '0 * * * *' });
  assert.equal(duplicate.outcome, 'ok');
  assert.equal(calls.length, 4);
  const http = await mf.dispatchFetch('https://example.test/');
  assert(http.status >= 400);
  assert.equal(calls.length, 4);
  console.log('PASS workerd scheduled event, SQLite DO, deduplication, no public handler; all outbound requests mocked');
} finally {
  await mf.dispose();
}
