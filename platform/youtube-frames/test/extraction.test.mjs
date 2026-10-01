import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractWithProxyFallback } from '../extraction.mjs';
import { createFrameTransport, tunnelStatus } from '../egress.mjs';
const environment = { OUTBOUND_PROXY_URLS: JSON.stringify(['http://one.test', 'http://two.test']) };
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
    transportFactory: (_, { excludeSlot }) => { selections.push(excludeSlot); const slot = excludeSlot === undefined ? 0 : 1; return { slot, proxyConfigured: true, fetch: slot, close: async () => closed.push(slot) }; },
    extractFrames: async options => { budgets.push(options.timeBudgetMs); assert.equal(options.preferResolution, false); if (options.fetch === 0) { clock = 6000; throw tunnel(); } return { frames: ['ok'] }; },
  });
  assert.deepEqual(result.frames, ['ok']); assert.deepEqual(selections, [undefined, 0]);
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
