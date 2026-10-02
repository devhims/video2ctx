import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractWithProxyFallback, MEDIA_FIRST_RESPONSE_TIMEOUT_MS, ROUTE_FIRST_RESPONSE_TIMEOUT_MS } from '../extraction.mjs';
import { createFrameTransport, tunnelStatus } from '../egress.mjs';
const environment = { OUTBOUND_PROXY_URLS: JSON.stringify(['http://one.test', 'http://two.test']) };
const pool4 = { OUTBOUND_PROXY_URLS: JSON.stringify(['http://one.test', 'http://two.test', 'http://three.test', 'http://four.test']) };
// Picks the lowest slot not yet excluded, so tests can follow the route sequence.
const nextSlot = excludeSlots => [0, 1, 2, 3].find(slot => !excludeSlots.includes(slot));
const tunnel = () => Object.assign(new Error('Outbound proxy tunnel failed.'), { code: 'PROXY_TUNNEL_FAILED', status: 522 });
test('nested tunnel failures latch the route and never retry media on that route', async () => {
  let calls = 0;
  const nested = new TypeError('fetch failed', { cause: new Error('cancelled', { cause: new Error('Proxy response (522) !== 200 when HTTP Tunneling') }) });
  assert.equal(tunnelStatus(nested), 522);
  assert.equal(tunnelStatus(new Error('YouTube returned 403')), undefined);
  const transport = createFrameTransport(environment, { select: () => 0, createDispatcher: () => ({ close: async () => {} }), fetch: async () => { calls++; throw nested; } });
  for (let i = 0; i < 2; i++) await assert.rejects(transport.fetch('https://media.test'), { code: 'PROXY_TUNNEL_FAILED', status: 522 });
  assert.equal(calls, 1);
  await transport.close();
});
test('alternate route restarts extraction with fresh metadata and remaining budget', async () => {
  let clock = 0; const selections = [], closed = [], budgets = [];
  const result = await extractWithProxyFallback({}, { environment, now: () => clock,
    transportFactory: (_, { excludeSlots }) => { selections.push(excludeSlots); const slot = nextSlot(excludeSlots); return { slot, proxyConfigured: true, fetch: slot, close: async () => closed.push(slot) }; },
    extractFrames: async options => { budgets.push(options.timeBudgetMs); assert.equal(options.preferResolution, false); if (options.fetch === 0) { clock = 6000; throw tunnel(); } return { frames: ['ok'] }; },
  });
  assert.deepEqual(result.frames, ['ok']); assert.deepEqual(selections, [[], [0]]);
  assert.deepEqual(budgets, [45000, 39000]); assert.deepEqual(closed, [0, 1]);
});
for (const scenario of ['ordinary error', 'single proxy', 'budget exhausted', 'both fail']) test(`bounded retry: ${scenario}`, async () => {
  let calls = 0, clock = 0;
  await assert.rejects(extractWithProxyFallback({}, { environment: scenario === 'single proxy' ? { OUTBOUND_PROXY_URL: 'http://one.test' } : environment, now: () => clock,
    transportFactory: () => ({ slot: 0, close: async () => {} }),
    extractFrames: async () => { calls++; if (scenario === 'budget exhausted') clock = 42000; throw scenario === 'ordinary error' ? new Error('403') : tunnel(); },
  }));
  assert.equal(calls, scenario === 'both fail' ? 2 : 1);
});
test('media route probe runs only while another proxy remains', async () => {
  let clock = 0; const probes = [];
  const transportFactory = (_, { excludeSlots }) => ({ slot: nextSlot(excludeSlots), proxyConfigured: true, fetch: nextSlot(excludeSlots), close: async () => {} });
  // A stalled first route surfaces as a tunnel failure; the final route keeps the full FFmpeg wait.
  const stalled = () => Object.assign(new Error('Outbound media route did not respond.'), { code: 'PROXY_TUNNEL_FAILED', causeCode: 'ETIMEDOUT' });
  const result = await extractWithProxyFallback({}, { environment, now: () => clock, transportFactory,
    extractFrames: async options => { probes.push(options.mediaFirstResponseTimeoutMs); if (options.fetch === 0) { clock = 3000; throw stalled(); } return { frames: ['ok'] }; },
  });
  assert.deepEqual(result.frames, ['ok']);
  assert.deepEqual(probes, [MEDIA_FIRST_RESPONSE_TIMEOUT_MS, undefined]);
  probes.length = 0;
  await extractWithProxyFallback({}, { environment: { OUTBOUND_PROXY_URL: 'http://one.test' }, transportFactory,
    extractFrames: async options => { probes.push(options.mediaFirstResponseTimeoutMs); return { frames: ['ok'] }; } });
  assert.deepEqual(probes, [undefined]);
});
test('closing a route with a stalled CONNECT does not wait for undici timeouts', async () => {
  let destroyed = false;
  const transport = createFrameTransport(environment, { select: () => 0, closeGraceMs: 20,
    createDispatcher: () => ({ close: () => new Promise(() => {}), destroy: async () => { destroyed = true; } }) });
  const startedAt = Date.now();
  await transport.close();
  assert.ok(Date.now() - startedAt < 1000);
  assert.equal(destroyed, true);
});
test('a failed route is torn down without the close grace', async () => {
  let destroyed = false;
  const transport = createFrameTransport(environment, { select: () => 0, closeGraceMs: 5_000,
    createDispatcher: () => ({ close: () => new Promise(() => {}), destroy: async () => { destroyed = true; } }) });
  const startedAt = Date.now();
  await transport.close({ force: true });
  assert.ok(Date.now() - startedAt < 100);
  assert.equal(destroyed, true);
});
test('a job visits up to four proxies, excluding every failed slot', async () => {
  let clock = 0; const routes = [], probes = [], routeGuards = [];
  const result = await extractWithProxyFallback({}, { environment: pool4, now: () => clock,
    transportFactory: (_, { excludeSlots, firstResponseTimeoutMs }) => {
      routes.push(excludeSlots); routeGuards.push(firstResponseTimeoutMs);
      const slot = nextSlot(excludeSlots); return { slot, proxyConfigured: true, fetch: slot, close: async () => {} };
    },
    extractFrames: async options => {
      probes.push(options.mediaFirstResponseTimeoutMs);
      if (options.fetch < 3) { clock += 4000; throw tunnel(); }
      return { frames: ['ok'] };
    },
  });
  assert.deepEqual(result.frames, ['ok']);
  assert.deepEqual(routes, [[], [0], [0, 1], [0, 1, 2]]);
  // Probes stay on until the last remaining proxy.
  assert.deepEqual(probes, [MEDIA_FIRST_RESPONSE_TIMEOUT_MS, MEDIA_FIRST_RESPONSE_TIMEOUT_MS, MEDIA_FIRST_RESPONSE_TIMEOUT_MS, undefined]);
  assert.deepEqual(routeGuards, [ROUTE_FIRST_RESPONSE_TIMEOUT_MS, ROUTE_FIRST_RESPONSE_TIMEOUT_MS, ROUTE_FIRST_RESPONSE_TIMEOUT_MS, undefined]);
});
test('a four-proxy job stops when the remaining budget cannot fit another route', async () => {
  let clock = 0, calls = 0;
  await assert.rejects(extractWithProxyFallback({}, { environment: pool4, now: () => clock,
    transportFactory: (_, { excludeSlots }) => ({ slot: nextSlot(excludeSlots), close: async () => {} }),
    extractFrames: async () => { calls++; clock += 21_000; throw tunnel(); },
  }), { code: 'PROXY_TUNNEL_FAILED' });
  assert.equal(calls, 2);
});
test('a stalled first YouTube response latches the route as a tunnel failure', async () => {
  let calls = 0;
  const transport = createFrameTransport(environment, { select: () => 0, firstResponseTimeoutMs: 30,
    createDispatcher: () => ({ close: async () => {} }),
    fetch: async (_input, init) => { calls++; return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })); } });
  const startedAt = Date.now();
  await assert.rejects(transport.fetch('https://youtube.test/player'), { code: 'PROXY_TUNNEL_FAILED', causeCode: 'ETIMEDOUT' });
  assert.ok(Date.now() - startedAt < 1000);
  // Library retries then fail immediately instead of waiting out the stall again.
  await assert.rejects(transport.fetch('https://youtube.test/player'), { code: 'PROXY_TUNNEL_FAILED' });
  assert.equal(calls, 1);
  assert.equal(transport.failure?.causeCode, 'ETIMEDOUT');
  await transport.close();
});
test('the route deadline stops applying once the route answers, and caller aborts are not route failures', async () => {
  let call = 0;
  const transport = createFrameTransport(environment, { select: () => 0, firstResponseTimeoutMs: 30,
    createDispatcher: () => ({ close: async () => {} }),
    fetch: async (_input, init) => {
      call++;
      if (call === 2) await new Promise(resolve => setTimeout(resolve, 80));
      if (call === 3) return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
      return new Response('ok');
    } });
  assert.equal((await transport.fetch('https://youtube.test/a')).status, 200);
  assert.equal((await transport.fetch('https://youtube.test/b')).status, 200);
  const caller = new AbortController(); setTimeout(() => caller.abort(), 20);
  await assert.rejects(transport.fetch('https://youtube.test/c', { signal: caller.signal }));
  assert.equal(transport.failure, undefined);
  await transport.close();
});
test('a slow concurrent YouTube request survives once another request on the route answered', async () => {
  const transport = createFrameTransport(environment, { select: () => 0, firstResponseTimeoutMs: 50,
    createDispatcher: () => ({ close: async () => {} }),
    // Honors abort like a real fetch, so a stray route timer would fail the slow request.
    fetch: (input, init) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(new Response('ok')), input.endsWith('/slow') ? 120 : 10);
      init.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(init.signal.reason); }, { once: true });
    }) });
  const [fast, slow] = await Promise.all([transport.fetch('https://youtube.test/fast'), transport.fetch('https://youtube.test/slow')]);
  assert.equal(fast.status, 200); assert.equal(slow.status, 200);
  assert.equal(transport.failure, undefined);
  await transport.close();
});

test('a Worker proxy order is followed, skipping slots that already failed', async () => {
  let clock = 0; const preferred = [];
  const result = await extractWithProxyFallback({}, { environment: pool4, now: () => clock, proxyOrder: [2, 0, 3, 1],
    transportFactory: (_, { excludeSlots, preferSlot }) => {
      preferred.push(preferSlot);
      return { slot: preferSlot ?? nextSlot(excludeSlots), proxyConfigured: true, fetch: preferSlot, close: async () => {} };
    },
    extractFrames: async options => {
      if (options.fetch !== 3) { clock += 4000; throw tunnel(); }
      return { frames: ['ok'] };
    },
  });
  assert.deepEqual(result.frames, ['ok']);
  assert.deepEqual(preferred, [2, 0, 3]);
});
