import test from 'node:test';
import assert from 'node:assert/strict';
import { summarize } from './run.mjs';
import { counterDelta, measure } from '../../youtube-processor/benchmark-metrics.mjs';

test('failures and warmups cannot make a tier appear faster; concurrency stays separate', () => {
  const base = { tier: 'lite', phase: 'warm', concurrency: 1, status: 200, textLength: 10 };
  const result = summarize([
    { ...base, clientMs: 9000 }, { ...base, clientMs: 10000 },
    { ...base, clientMs: 1, status: 404 }, { ...base, clientMs: 2, textLength: 0 },
    { ...base, clientMs: 3, phase: 'warmup' }, { ...base, clientMs: 20000, concurrency: 3 },
  ]);
  assert.deepEqual(result['lite/warm/concurrency-1'].clientMs, { n: 2, p50: 9000, p95: 10000 });
  assert.equal(result['lite/warm/concurrency-1'].failures, 2);
  assert.equal(result['lite/warm/concurrency-3'].clientMs.p50, 20000);
});

test('missing cgroup counters are unknown, not zero throttling', () => {
  assert.equal(counterDelta(null, { throttled_usec: 0 }), null);
  assert.deepEqual(counterDelta({ throttled_usec: 10 }, { throttled_usec: 35 }), { throttled_usec: 25 });
});

test('measurement consumes the response and keeps success and error status intact', async () => {
  const result = await measure(async () => new Response('{"error":{"code":"NOT_FOUND"}}', { status: 404 }));
  assert.equal(result.response.status, 404);
  assert.equal(JSON.parse(result.body).error.code, 'NOT_FOUND');
  assert.ok(result.metrics.durationMs >= 0);
  assert.ok(result.metrics.processCpuMs >= 0);
});
