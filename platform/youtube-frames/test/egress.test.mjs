import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFrameTransport, proxyConnections } from '../egress.mjs';
import { redact } from '../diagnostics.mjs';

const pool = ['http://first:secret-one@proxy.test:8000/', 'http://second:secret-two@proxy.test:8000/'];
test('pool-only configuration keeps metadata and media on one selected dispatcher', async () => {
  const calls = []; let selections = 0; let closed = false;
  const dispatcher = { close: async () => { closed = true; } };
  const transport = createFrameTransport({ OUTBOUND_PROXY_URLS: JSON.stringify(pool) }, {
    select: count => { assert.equal(count, 2); selections++; return 1; },
    createDispatcher: url => { assert.equal(url, pool[1]); return dispatcher; },
    fetch: async (url, init) => { calls.push({url, init}); return new Response('ok'); },
    directFetch: () => { throw new Error('must not bypass proxy'); },
  });
  const signal = new AbortController().signal;
  await transport.fetch('https://youtube.test/player', { signal });
  await transport.fetch('https://media.test/video', { headers: { Range: 'bytes=0-1023' }, signal });
  assert.equal(selections, 1);
  assert.equal(transport.proxyConfigured, true);
  assert.ok(calls.every(call => call.init.dispatcher === dispatcher && call.init.signal === signal));
  assert.equal(calls[1].init.headers.Range, 'bytes=0-1023');
  await transport.close(); assert.equal(closed, true);
});
test('pool takes precedence over legacy, and legacy remains a fallback', () => {
  assert.deepEqual(proxyConnections({ OUTBOUND_PROXY_URLS: JSON.stringify(pool), OUTBOUND_PROXY_URL: 'http://legacy.test:9000' }), pool);
  assert.deepEqual(proxyConnections({ OUTBOUND_PROXY_URL: pool[0] }), [pool[0]]);
});
test('bad pool never falls back to direct or legacy transport and does not expose credentials', () => {
  for (const value of ['not-json-secret', '[]', '{}', JSON.stringify([pool[0],pool[0]]), JSON.stringify(['ftp://user:password@proxy.test']), JSON.stringify([...pool,...pool,pool[0]])]) {
    assert.throws(() => createFrameTransport({ OUTBOUND_PROXY_URLS: value, OUTBOUND_PROXY_URL: pool[0] }),
      error => error.message === 'Outbound proxy configuration must contain one to four distinct HTTP(S) proxy URLs.');
  }
});
test('unconfigured local extraction retains direct access', async () => {
  const directFetch = () => new Response('direct');
  const transport = createFrameTransport({}, { directFetch });
  assert.equal(transport.fetch, directFetch); assert.equal(transport.proxyConfigured, false);
  await transport.close();
});
test('redacts every pool entry including encoded and decoded credentials', () => {
  const saved = process.env.OUTBOUND_PROXY_URLS;
  try {
    process.env.OUTBOUND_PROXY_URLS = JSON.stringify([...pool,'http://encoded%40user:encoded%21pass@proxy.test']);
    const result = redact(`${pool.join(' ')} secret-one secret-two first second encoded%40user encoded@user encoded%21pass encoded!pass`);
    for (const secret of ['secret-one','secret-two','first','second','encoded%40user','encoded@user','encoded%21pass','encoded!pass']) assert.ok(!result.includes(secret));
  } finally { if (saved === undefined) delete process.env.OUTBOUND_PROXY_URLS; else process.env.OUTBOUND_PROXY_URLS = saved; }
});

test('an alternate route excludes the failed pool slots', async () => {
  const transport = createFrameTransport({ OUTBOUND_PROXY_URLS: JSON.stringify(pool) }, {
    excludeSlots: [0], select: count => { assert.equal(count, 1); return 0; },
    createDispatcher: url => { assert.equal(url, pool[1]); return { close: async () => {} }; },
  });
  assert.equal(transport.slot, 1);
  await transport.close();
});

test('a preferred slot is used when available and ignored when excluded', async () => {
  const chosen = [];
  for (const options of [{ preferSlot: 1 }, { preferSlot: 1, excludeSlots: [1], select: () => 0 }, { preferSlot: 7, select: () => 0 }]) {
    const transport = createFrameTransport({ OUTBOUND_PROXY_URLS: JSON.stringify(pool) }, {
      ...options, createDispatcher: () => ({ close: async () => {} }),
    });
    chosen.push(transport.slot);
    await transport.close();
  }
  assert.deepEqual(chosen, [1, 0, 0]);
});
