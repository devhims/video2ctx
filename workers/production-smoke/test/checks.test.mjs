import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import worker, { SmokeGuard } from '../src/index.mjs';
import { ORIGIN, VIDEO_ID, MESSAGE, LIMITS, client, transcriptCheck, submitAgent, pollAgent, safeFailure, CheckError } from '../src/checks.mjs';
const run = { sessionId: '00000000-0000-4000-8000-000000000001', runId: '00000000-0000-4000-8000-000000000002' };
const transcript = { videoId: VIDEO_ID, text: 'fixture text', segments: [{ text: 'fixture text', startMs: 0 }], meta: { partial: false } };
const complete = { ...run, status: 'completed', result: { outcome: 'answered', answer: 'A cited answer [1]', sources: [{ id: '1', videoId: VIDEO_ID }], evidence: [{ sourceId: '1', id: `transcript:${VIDEO_ID}:0:0:0` }] } };
const response = (value, status = 200) => Response.json(value, { status });
const virtualTime = () => { let time = 0; return { now: () => time, sleep: async ms => { time += ms; } }; };
test('deployment has no HTTP entrypoint or public routes and is disabled', async () => {
  const config = JSON.parse(await readFile(new URL('../wrangler.json', import.meta.url)));
  assert.equal(worker.fetch, undefined); assert.deepEqual(Object.keys(worker), ['scheduled']);
  assert.equal(config.workers_dev, false); assert.equal(config.preview_urls, false);
  assert.deepEqual(config.routes, []); assert.deepEqual(config.triggers.crons, []);
  assert.equal(config.vars.CHECKS_ENABLED, 'false');
});
test('disabled or missing-key events cannot call the binding', async () => {
  await worker.scheduled({}, { CHECKS_ENABLED: 'false' });
  await assert.rejects(worker.scheduled({}, { CHECKS_ENABLED: 'true' }), /not configured/);
});
test('client fixes host, sends Bearer, forbids redirects, parses JSON', async () => {
  const request = client('test-secret', async (url, options) => {
    assert.equal(url, `${ORIGIN}/test`); assert.equal(options.headers.Authorization, 'Bearer test-secret');
    assert.equal(options.redirect, 'manual'); return response({ ok: true });
  });
  assert.deepEqual(await request('/test'), { ok: true });
});
for (const status of [302, 401, 403, 429, 500]) test(`HTTP ${status} is sanitized, never retried`, async () => {
  let calls = 0;
  const request = client('test-secret', async () => { calls++; return response({ error: 'test-secret' }, status); });
  await assert.rejects(request('/test'), error => { assert.deepEqual(safeFailure(error), { status: 'failed', code: 'HTTP_ERROR', httpStatus: status }); return true; });
  assert.equal(calls, 1);
});
test('malformed JSON, network errors, and oversized bodies are sanitized', async () => {
  for (const [fetcher, code] of [
    [async () => new Response('test-secret'), 'INVALID_JSON'],
    [async () => { throw new Error('test-secret'); }, 'NETWORK_ERROR'],
    [async () => new Response('x'.repeat(LIMITS.bodyBytes + 1)), 'RESPONSE_TOO_LARGE'],
  ]) await assert.rejects(client('test-secret', fetcher)('/test'), { code });
});
test('timeout covers stalled response body', async () => {
  const fetcher = async () => new Response(new ReadableStream({ start() {} }));
  await assert.rejects(client('test-secret', fetcher)('/test', { timeoutMs: 10 }), { code: 'REQUEST_TIMEOUT' });
});
test('valid transcript and invalid/partial/empty responses', async () => {
  assert.equal((await transcriptCheck(async () => transcript)).status, 'passed');
  for (const value of [{}, { ...transcript, videoId: 'bad' }, { ...transcript, text: '' }, { ...transcript, segments: [] }, { ...transcript, meta: { partial: true } }])
    await assert.rejects(transcriptCheck(async () => value), { code: 'INVALID_TRANSCRIPT' });
});
test('admission makes exactly one POST, fixed one-video prompt, no retry', async () => {
  let calls = 0;
  await assert.rejects(submitAgent(async (path, options) => {
    calls++; assert.equal(path, '/v1/agent?responseFormat=compact');
    assert.deepEqual(options, { method: 'POST', body: { message: MESSAGE } });
    throw new CheckError('NETWORK_ERROR');
  })); assert.equal(calls, 1);
});
test('POST must return 202', async () => {
  await assert.rejects(submitAgent(client('test', async () => response(run))), { code: 'INVALID_ADMISSION_STATUS' });
});
test('agent passes only completed, answered, cited transcript evidence', async () => {
  assert.equal((await pollAgent(async () => complete, run)).status, 'passed');
  for (const result of [{ outcome: 'partial' }, { ...complete.result, evidence: [] }, { ...complete.result, answer: '' }, { ...complete.result, answer: 'No citation marker' }, { ...complete.result, sources: {} }])
    assert.equal((await pollAgent(async () => ({ ...complete, result }), run)).status, 'failed');
});
test('pending/running use bounded polling then remain resumable', async () => {
  let calls = 0;
  const result = await pollAgent(async () => { calls++; return { ...run, status: calls === 1 ? 'pending' : 'running' }; }, run, virtualTime());
  assert.equal(calls, LIMITS.polls); assert.equal(result.code, 'POLL_WINDOW_EXPIRED'); assert.equal(result.terminal, false);
});
test('poll errors defer, terminal failures terminate, IDs cannot redirect polling', async () => {
  assert.equal((await pollAgent(async () => { throw new CheckError('HTTP_ERROR', 429); }, run)).terminal, false);
  assert.equal((await pollAgent(async () => ({ ...run, status: 'failed', error: 'secret' }), run)).code, 'AGENT_FAILED');
  assert.equal((await pollAgent(async () => ({ ...complete, runId: 'other' }), run)).code, 'RUN_ID_MISMATCH');
  await assert.rejects(pollAgent(async () => {}, { sessionId: '../../evil', runId: run.runId }), { code: 'INVALID_RECEIPT' });
});
function memoryStorage() {
  const map = new Map(); let queue = Promise.resolve();
  const storage = { get: async k => structuredClone(map.get(k)), put: async (k, v) => { map.set(k, structuredClone(v)); }, delete: async k => map.delete(k), transaction: fn => {
    const next = queue.then(() => fn(storage)); queue = next.catch(() => {}); return next;
  } }; return storage;
}
const event = time => new Request('https://smoke.internal/scheduled', { method: 'POST', body: JSON.stringify({ scheduledTime: time }) });
const env = { CHECKS_ENABLED: 'true', VIDEO2CTX_API_KEY: 'test-secret' };
test('persistent guard deduplicates and resumes without another POST', async t => {
  const storage = memoryStorage(); await storage.put('pending', run);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return response(complete); });
  const guard = new SmokeGuard({ storage }, env);
  assert.equal((await guard.fetch(event(1000))).status, 204);
  assert.equal((await guard.fetch(event(1000))).status, 204);
  assert.equal(calls, 1); assert.equal(await storage.get('pending'), undefined);
});
test('uncertain admission fails closed without calls; lease prevents overlap', async t => {
  const storage = memoryStorage(); await storage.put('pending', { uncertain: true });
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('must not fetch'); });
  assert.equal((await new SmokeGuard({ storage }, env).fetch(event(1000))).status, 503);
  await storage.put('guard', { lastScheduled: 1000, busyUntil: Date.now() + 10000 });
  assert.equal((await new SmokeGuard({ storage }, env).fetch(event(2000))).status, 204);
});
test('happy scheduled run is sequential and logs neither key nor response text', async t => {
  const storage = memoryStorage(); const urls = []; const logs = [];
  t.mock.method(console, 'log', line => logs.push(line));
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    urls.push([url, options.method]);
    if (url.includes('/transcript?')) return response(transcript);
    if (url.endsWith('/access')) return response({ enabled: true });
    if (options.method === 'POST') { assert.deepEqual(await storage.get('pending'), { uncertain: true }); return response(run, 202); }
    return response(complete);
  });
  assert.equal((await new SmokeGuard({ storage }, env).fetch(event(1000))).status, 204);
  assert.deepEqual(urls.map(x => x[1]), ['GET', 'GET', 'POST', 'GET']);
  assert.equal(await storage.get('pending'), undefined);
  assert(!logs.join().includes('test-secret')); assert(!logs.join().includes('fixture text')); assert(!logs.join().includes('A cited answer'));
});
test('lost receipt never resubmits next cron; denied access does not poison guard', async t => {
  const storage = memoryStorage(); let posts = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.includes('/transcript?')) return response(transcript);
    if (url.endsWith('/access')) return response({ enabled: true });
    posts++; throw new Error('lost receipt test-secret');
  });
  const guard = new SmokeGuard({ storage }, env);
  assert.equal((await guard.fetch(event(1000))).status, 503);
  assert.equal((await guard.fetch(event(2000))).status, 503);
  assert.equal(posts, 1);
  const clean = memoryStorage();
  t.mock.method(globalThis, 'fetch', async url => url.includes('/transcript?') ? response(transcript) : response({}, 403));
  await new SmokeGuard({ storage: clean }, env).fetch(event(3000));
  assert.equal(await clean.get('pending'), undefined);
});
