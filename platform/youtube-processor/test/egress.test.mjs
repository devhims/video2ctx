import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { proxyConnections } from '../egress.mjs';
import { createYouTubeRuntime } from '../runtime.mjs';
import { createProcessorApp } from '../app.mjs';
const require = createRequire(import.meta.url);
const youtube = require('all-things-youtube');
const urls = ['http://user:password@proxy.example:10001', 'http://user:password@proxy.example:10002'];

test('pool takes precedence; legacy and direct configurations remain supported', () => {
  assert.deepEqual(proxyConnections({}), []);
  assert.deepEqual(proxyConnections({ OUTBOUND_PROXY_URL: urls[0] }), [urls[0] + '/']);
  assert.deepEqual(proxyConnections({ OUTBOUND_PROXY_URL: 'invalid', OUTBOUND_PROXY_URLS: JSON.stringify(urls) }), urls.map(url => url + '/'));
});

test('invalid pool fails closed without exposing credentials', () => {
  for (const pool of ['private-password', '[]', '{}', JSON.stringify([urls[0], urls[0]]), JSON.stringify(['socks5://user:private-password@proxy.example:1080'])]) {
    assert.throws(() => proxyConnections({ OUTBOUND_PROXY_URLS: pool }), error => {
      assert.equal(error.message.includes('private-password'), false);
      assert.equal(error.message.includes('user:'), false);
      return true;
    });
  }
});

test('concurrent extractions use separate proxy connections and keep their connection for all reads', async () => {
  const original = youtube.getTranscript;
  const seen = [];
  const proxies = await Promise.all([0,1].map(async slot => {
    const server = createServer((request, response) => {
      seen.push(slot);
      assert.equal(request.url, 'http://upstream.test/captions');
      response.end(JSON.stringify({ slot }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return server;
  }));
  youtube.getTranscript = async options => {
    assert.equal(options.retry.policy.maxAttempts, 2);
    const reads = [];
    for (let n=0; n<2; n++) {
      const response = await options.fetch('http://upstream.test/captions');
      reads.push((await response.json()).slot);
    }
    assert.deepEqual(reads, [reads[0], reads[0]]);
    return { text: 'test', segments: [] };
  };
  try {
    const runtime = createYouTubeRuntime({ OUTBOUND_PROXY_URLS: JSON.stringify(proxies.map(server =>
      `http://127.0.0.1:${server.address().port}`)) });
    assert.equal(runtime.proxyConfigured, true);
    assert.equal(runtime.proxyConnections, 2);
    await Promise.all([0,1].map(egressSlot => runtime.run({ kind: 'transcript', id: 'AR1Gi3RHanE' }, { egressSlot })));
    assert.deepEqual(seen.sort(), [0,0,1,1]);
    await assert.rejects(runtime.run({ kind: 'transcript' }, { egressSlot: 4 }), { code: 'INVALID_INPUT' });
  } finally {
    youtube.getTranscript = original;
    for (const server of proxies) server.closeAllConnections();
    await Promise.all(proxies.map(server => new Promise(resolve => server.close(resolve))));
  }
});

test('processor forwards and validates the private egress slot without exposing URLs', async () => {
  const calls = [];
  const app = createProcessorApp({ proxyConfigured: true, proxyConnections: 2,
    run: async (operation, diagnostics) => { calls.push(diagnostics.egressSlot); return { text: 'ok' }; } });
  for (const slot of ['0','1','-1','4','1.5','secret']) {
    const response = await app.request('/operations', { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-processor-egress-slot': slot },
      body: JSON.stringify({ kind: 'transcript', id: 'AR1Gi3RHanE' }) });
    assert.equal(response.status, ['0','1'].includes(slot) ? 200 : 422);
  }
  assert.deepEqual(calls, [0,1]);
  const health = await (await app.request('/health')).json();
  assert.equal(health.proxyConnections, 2);
  assert.equal(JSON.stringify(health).includes('password'), false);
});

test('the transcript deadline cancels response-body reads', async t => {
  const original = youtube.getTranscript;
  const controller = new AbortController();
  const originalTimeout = AbortSignal.timeout;
  t.mock.method(AbortSignal, 'timeout', ms => ms === 25_000 ? controller.signal : originalTimeout(ms));
  let bodyStarted;
  const started = new Promise(resolve => { bodyStarted = resolve; });
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{');
    bodyStarted();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  youtube.getTranscript = async options => {
    const response = await options.fetch(`http://127.0.0.1:${server.address().port}/captions`);
    await response.text();
  };
  try {
    const runtime = createYouTubeRuntime({});
    const pending = runtime.run({ kind: 'transcript', id: 'AR1Gi3RHanE' });
    const rejected = assert.rejects(pending, { code: 'UNAVAILABLE', retryable: true });
    await started;
    controller.abort(new DOMException('Timed out', 'TimeoutError'));
    await rejected;
  } finally {
    youtube.getTranscript = original;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
