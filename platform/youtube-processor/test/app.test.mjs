import assert from 'node:assert/strict';
import test from 'node:test';
import { createProcessorApp, OPERATION_KINDS } from '../app.mjs';
import { createYouTubeRuntime, redactProxyError } from '../runtime.mjs';

test('returns bounded storyboard diagnostics on success and error', async () => {
  for (const fail of [false, true]) {
    const app = createProcessorApp({ run: async (_operation, { onDiagnostic, extractionId }) => {
      assert.equal(extractionId, '00000000-0000-4000-8000-000000000001');
      for (let index = 0; index < 80; index++) onDiagnostic({ stage: 'player', elapsedMs: index });
      onDiagnostic({ stage: 'complete', outcome: 'success' });
      if (fail) throw Object.assign(new Error('Unavailable'), { code: 'UNAVAILABLE' });
      return { sheets: [] };
    } });
    const response = await app.request('/operations', { method: 'POST', headers: {
      'content-type': 'application/json', 'x-extraction-id': '00000000-0000-4000-8000-000000000001',
    }, body: JSON.stringify({ kind: 'storyboard', id: 'abcdefghijk' }) });
    const payload = await response.json();
    assert.equal(response.status, fail ? 503 : 200);
    assert.equal(payload.diagnostics.events.length, 64);
    assert.equal(payload.diagnostics.droppedEvents, 17);
    assert.equal(payload.diagnostics.events[0].elapsedMs, 0);
    assert.equal(payload.diagnostics.events.at(-1).stage, 'complete');
  }
});

test('concurrent storyboard operations cannot share diagnostics', async () => {
  const app = createProcessorApp({ run: async (operation, { onDiagnostic }) => {
    onDiagnostic({ stage: 'player', elapsedMs: operation.marker });
    await new Promise(resolve => setTimeout(resolve, 5));
    return {};
  } });
  const results = await Promise.all([1, 2].map(async marker => (await app.request('/operations', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'storyboard', marker }),
  })).json()));
  assert.deepEqual(results.map(result => result.diagnostics.events), [[{ stage: 'player', elapsedMs: 1 }], [{ stage: 'player', elapsedMs: 2 }]]);
});

test('accepts every internal YouTube operation kind', async () => {
  const seen = [];
  const app = createProcessorApp({
    proxyConfigured: true,
    run: async (operation) => {
      seen.push(operation.kind);
      return { operation: operation.kind };
    },
  });

  for (const kind of OPERATION_KINDS) {
    const response = await app.request('/operations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { value: { operation: kind },
      ...(['storyboard', 'transcript'].includes(kind) ? { diagnostics: { version: 1, events: [], droppedEvents: 0 } } : {}) });
  }

  assert.deepEqual(seen, [...OPERATION_KINDS]);
});

test('reports proxy configuration without revealing the proxy URL', async () => {
  const app = createProcessorApp({ proxyConfigured: true, run: async () => ({}) });
  const response = await app.request('/health');
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.proxyConfigured, true);
  assert.equal(JSON.stringify(body).includes('OUTBOUND_PROXY_URL'), false);
});

test('configures the processor transport from OUTBOUND_PROXY_URL', () => {
  assert.equal(createYouTubeRuntime({}).proxyConfigured, false);
  assert.equal(createYouTubeRuntime({ OUTBOUND_PROXY_URL: 'http://proxy.example.com:8080' }).proxyConfigured, true);
});

test('redacts the configured proxy URL from processing errors', () => {
  const proxy = 'http://user:password@proxy.example.com:8080';
  const error = Object.assign(new Error(`connect failed through ${proxy}`), {
    code: 'UPSTREAM_ERROR',
    retryable: true,
  });
  const redacted = redactProxyError(error, proxy);

  assert.equal(redacted.message.includes(proxy), false);
  assert.equal(redacted.message.includes('password'), false);
  assert.equal(redacted.code, 'UPSTREAM_ERROR');
});

test('normalizes classified processing failures', async () => {
  const app = createProcessorApp({
    proxyConfigured: false,
    run: async () => {
      throw Object.assign(new Error('YouTube is rate limited.'), {
        code: 'RATE_LIMITED',
        status: 429,
        retryable: true,
      });
    },
  });

  const response = await app.request('/operations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'video', id: 'abcdefghijk' }),
  });

  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), { error: {
    code: 'RATE_LIMITED',
    message: 'YouTube is rate limited.',
    status: 429,
    retryable: true,
  } });
});

test('rejects unsupported operations before invoking the runtime', async () => {
  let calls = 0;
  const app = createProcessorApp({
    proxyConfigured: false,
    run: async () => { calls += 1; },
  });

  const response = await app.request('/operations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'delete-video' }),
  });

  assert.equal(response.status, 400);
  assert.equal(calls, 0);
});

test('rejects excess concurrent operations and releases capacity after completion', async () => {
  let release;
  const started = new Promise((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const app = createProcessorApp({
    proxyConfigured: false,
    run: async () => {
      calls += 1;
      if (calls === 1) await started;
      return { ok: true };
    },
  }, { maxConcurrentOperations: 1 });

  const operation = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'video', id: 'abcdefghijk' }),
  };
  const first = app.request('/operations', operation);
  while (calls === 0) await new Promise((resolve) => setImmediate(resolve));

  const busy = await app.request('/operations', operation);
  assert.equal(busy.status, 503);
  assert.equal(busy.headers.get('retry-after'), '1');
  assert.equal((await busy.json()).error.code, 'PROCESSOR_BUSY');

  release();
  assert.equal((await first).status, 200);
  assert.equal((await app.request('/operations', operation)).status, 200);
  assert.equal(calls, 2);
});


test('timing diagnostics correlate operations without logging transcript content', async (t) => {
  const logs = [];
  t.mock.method(console, 'log', message => logs.push(JSON.parse(message)));
  const app = createProcessorApp({ proxyConfigured: true, run: async () => ({ text: 'private fixture text' }) });
  const response = await app.request('/operations', { method: 'POST', headers: {
    'content-type': 'application/json', 'x-extraction-id': '00000000-0000-4000-8000-000000000002',
  }, body: JSON.stringify({ kind: 'transcript', id: 'abcdefghijk' }) });
  assert.equal(response.status, 200);
  const timing = logs.find(event => event.event === 'youtube_processor_timing');
  assert.equal(timing.extractionId, '00000000-0000-4000-8000-000000000002');
  assert.equal(timing.proxyConfigured, true);
  assert.ok(timing.durationMs >= 0 && timing.processCpuMs >= 0 && timing.rssBytes > 0);
  assert.equal(JSON.stringify(logs).includes('private fixture text'), false);
});
