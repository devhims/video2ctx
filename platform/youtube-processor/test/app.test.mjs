import assert from 'node:assert/strict';
import test from 'node:test';
import { createProcessorApp, OPERATION_KINDS } from '../app.mjs';
import { createYouTubeRuntime, redactProxyError } from '../runtime.mjs';

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
    assert.deepEqual(await response.json(), { value: { operation: kind } });
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
