import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDashboardCache } from './dashboard-cache.ts';
import { createCreditRefresher } from './credit-refresh.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

/** A ledger-backed account API: each read returns the balance at request time. */
function account(balance: number) {
  const ledger = { balance };
  const calls: string[] = [];
  const cache = createDashboardCache(async path => {
    calls.push(path);
    return path === '/v1/billing' ? { plan: 'starter', creditBalance: ledger.balance } : { creditBalance: ledger.balance };
  });
  return { ledger, calls, cache, refresher: createCreditRefresher(cache) };
}
const balance = (cache: ReturnType<typeof createDashboardCache>) => (cache.read('usage').data as { creditBalance?: number } | undefined)?.creditBalance;

test('a terminal run re-reads the settled balance even inside the freshness window', async () => {
  const { ledger, calls, cache, refresher } = account(678);
  await cache.load('usage');
  ledger.balance = 675;
  await cache.load('usage');
  assert.equal(balance(cache), 678, 'ordinary reads stay within the freshness window');
  await refresher.afterRunTerminal('run-1');
  assert.equal(balance(cache), 675);
  assert.deepEqual(calls, ['/v1/usage', '/v1/usage']);
});

test('a run that is already terminal in its first snapshot still refreshes once', async () => {
  // Fast completion, or a recovered view that never observed the run as active.
  const { ledger, calls, cache, refresher } = account(977);
  await cache.load('usage');
  ledger.balance = 974;
  await refresher.afterRunTerminal('fast-run');
  assert.equal(balance(cache), 974);
  assert.equal(calls.length, 2);
});

test('repeated terminal snapshots and remounted watchers read once per run', async () => {
  const { ledger, calls, cache, refresher } = account(700);
  await cache.load('usage');
  ledger.balance = 697;
  await refresher.afterRunTerminal('completed-run');
  assert.equal(refresher.afterRunTerminal('completed-run'), undefined);
  assert.equal(refresher.afterRunTerminal('completed-run'), undefined);
  ledger.balance = 696;
  await refresher.afterRunTerminal('failed-run');
  await refresher.afterRunTerminal('cancelled-run');
  assert.equal(balance(cache), 696);
  assert.equal(calls.filter(path => path === '/v1/usage').length, 4, 'initial read plus one per distinct run');
});

test('triggers in one tick share a single read', async () => {
  const { calls, cache, refresher } = account(500);
  await cache.load('usage');
  const reads = [refresher.afterRunTerminal('a'), refresher.afterRunTerminal('b'), refresher.refresh()];
  assert.equal(reads[0], reads[1]);
  assert.equal(reads[1], reads[2]);
  await Promise.all(reads);
  assert.equal(calls.length, 2);
});

test('a settlement during a pending read is not lost to deduplication', async () => {
  const ledger = { balance: 900 };
  const responses: ReturnType<typeof deferred<unknown>>[] = [];
  const cache = createDashboardCache(async () => {
    const response = deferred<unknown>();
    const value = { creditBalance: ledger.balance };
    responses.push(response);
    return response.promise.then(() => value);
  });
  const refresher = createCreditRefresher(cache);
  const first = refresher.refresh();
  await Promise.resolve();
  assert.equal(responses.length, 1);
  ledger.balance = 897; // a run settles after the first read started
  const second = refresher.afterRunTerminal('late-run')!;
  await Promise.resolve();
  assert.equal(responses.length, 2, 'the later trigger starts its own read');
  responses[1]!.resolve(undefined);
  await second;
  responses[0]!.resolve(undefined);
  await first;
  assert.equal(balance(cache), 897, 'the older pre-settlement response is discarded');
});

test('an older seeded or in-flight ordinary read cannot overwrite the refreshed balance', async () => {
  const seed = deferred<{ data: { creditBalance: number } }>();
  const ledger = { balance: 955 };
  const cache = createDashboardCache(async () => ({ creditBalance: ledger.balance }), { usage: seed.promise as never });
  const refresher = createCreditRefresher(cache);
  const initial = cache.load('usage');
  ledger.balance = 974;
  await refresher.afterRunTerminal('recovered-run');
  assert.equal(balance(cache), 974);
  seed.resolve({ data: { creditBalance: 955 } });
  await initial;
  assert.equal(balance(cache), 974);
});

test('billing refreshes only when it is already loaded', async () => {
  const { ledger, calls, cache, refresher } = account(400);
  await refresher.refresh();
  assert.deepEqual(calls, ['/v1/usage']);
  await cache.load('billing');
  ledger.balance = 397;
  await refresher.afterRunTerminal('run');
  assert.deepEqual(calls, ['/v1/usage', '/v1/billing', '/v1/usage', '/v1/billing']);
  assert.equal((cache.read('billing').data as { creditBalance: number }).creditBalance, 397);
});
