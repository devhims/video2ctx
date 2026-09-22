import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDashboardCache } from './dashboard-cache.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test('a pending project read does not delay billing; concurrent consumers share one read', async () => {
  const projects = deferred<unknown>();
  const calls: string[] = [];
  const cache = createDashboardCache(async path => {
    calls.push(path);
    return path === '/v1/projects' ? projects.promise : { plan: 'starter' };
  });
  const first = cache.load('projects');
  assert.equal(cache.load('projects'), first);
  await cache.load('billing');
  assert.equal(cache.read('billing').data?.plan, 'starter');
  assert.equal(cache.read('projects').loading, true);
  projects.resolve({ projects: [] });
  await first;
  await cache.load('projects');
  assert.deepEqual(calls, ['/v1/projects', '/v1/billing']);
});

test('server reads seed the cache without a duplicate browser request', async () => {
  const cache = createDashboardCache(async () => { throw new Error('Unexpected browser read'); }, {
    projects: Promise.resolve({ data: [{ id: 'p', name: 'Research' }] }),
  });
  await cache.load('projects');
  assert.equal(cache.read('projects').data?.[0].name, 'Research');
});

test('a failed initial read is not a confirmed empty list and can be retried', async () => {
  let attempts = 0;
  const cache = createDashboardCache(async () => {
    if (++attempts === 1) throw new Error('Unavailable');
    return { projects: [] };
  });
  await cache.load('projects');
  assert.equal(cache.read('projects').data, undefined);
  assert.equal(cache.read('projects').error, 'Unavailable');
  await cache.load('projects', true);
  assert.deepEqual(cache.read('projects').data, []);
  assert.equal(cache.read('projects').error, '');
});

test('an older in-flight read cannot overwrite a mutation', async () => {
  const projects = deferred<unknown>();
  const cache = createDashboardCache(() => projects.promise);
  const pending = cache.load('projects');
  cache.set('projects', [{ id: 'new', name: 'Created just now' }]);
  projects.resolve({ projects: [] });
  await pending;
  assert.equal(cache.read('projects').data?.[0].id, 'new');
});

test('a new account provider cannot see the previous account cache', async () => {
  const first = createDashboardCache(async () => ({ projects: [{ id: 'private', name: 'Private project' }] }));
  await first.load('projects');
  const second = createDashboardCache(async () => ({ projects: [] }));
  assert.equal(second.read('projects').data, undefined);
  await second.load('projects');
  assert.deepEqual(second.read('projects').data, []);
});


test('unused server data older than the freshness window is refreshed before use', async () => {
  let reads = 0;
  const cache = createDashboardCache(async () => { reads++; return { projects: [{ id: 'new', name: 'Current' }] }; }, {
    projects: Promise.resolve({ data: [{ id: 'old', name: 'Old' }], updatedAt: Date.now() - 61_000 }),
  });
  await cache.load('projects');
  assert.equal(reads, 1);
  assert.equal(cache.read('projects').data?.[0].id, 'new');
});


test('a mutation refresh supersedes a pending read taken before the mutation', async () => {
  const old = deferred<unknown>();
  const fresh = deferred<unknown>();
  let reads = 0;
  const cache = createDashboardCache(() => ++reads === 1 ? old.promise : fresh.promise);
  const initial = cache.load('projects');
  const refresh = cache.load('projects', true);
  assert.notEqual(initial, refresh);
  old.resolve({ projects: [] });
  await initial;
  assert.equal(cache.load('projects'), refresh);
  fresh.resolve({ projects: [{ id: 'new', name: 'Created' }] });
  await refresh;
  assert.equal(cache.read('projects').data?.[0].id, 'new');
});

test('rendered server results seed once without replacing newer browser data', async () => {
  let reads = 0;
  const cache = createDashboardCache(async () => { reads++; return { projects: [] }; });
  cache.initialize('projects', { data: [{ id: 'server', name: 'Server' }], updatedAt: Date.now() });
  await cache.load('projects');
  assert.equal(reads, 0);
  cache.set('projects', [{ id: 'new', name: 'Just created' }]);
  cache.initialize('projects', { data: [] });
  assert.equal(cache.read('projects').data?.[0].id, 'new');
});

test('streamed failures remain errors until retry and stale rendered data revalidates', async () => {
  let reads = 0;
  const cache = createDashboardCache(async () => { reads++; return { projects: [] }; });
  cache.initialize('projects', { error: 'Unavailable' });
  await cache.load('projects');
  assert.equal(reads, 0);
  assert.equal(cache.read('projects').error, 'Unavailable');
  await cache.load('projects', true);
  assert.deepEqual(cache.read('projects').data, []);
  const stale = createDashboardCache(async () => ({ projects: [{ id: 'fresh', name: 'Fresh' }] }));
  stale.initialize('projects', { data: [], updatedAt: Date.now() - 61_000 });
  await stale.load('projects');
  assert.equal(stale.read('projects').data?.[0].id, 'fresh');
});

test('a stale browser entry reuses a new route server read for revalidation', async () => {
  const cache = createDashboardCache(async () => { throw new Error('Unexpected duplicate browser request'); });
  cache.initialize('projects', { data: [], updatedAt: Date.now() - 61_000 });
  await cache.load('projects', false, Promise.resolve({ data: [{ id: 'fresh', name: 'Fresh from route' }], updatedAt: Date.now() }));
  assert.equal(cache.read('projects').data?.[0].id, 'fresh');
});

test('API key cache keeps only display metadata and rejects a malformed list', async () => {
  const cache = createDashboardCache(async () => ({ apiKeys: [{ id: 'key', name: 'Production', start: 'aty_', prefix: 'aty_', createdAt: '2026-09-23', lastRequest: null, key: 'secret', hash: 'private' }] }));
  await cache.load('apiKeys');
  assert.deepEqual(Object.keys(cache.read('apiKeys').data![0]).sort(), ['createdAt', 'id', 'lastRequest', 'name', 'prefix', 'start']);
  const invalid = createDashboardCache(async () => ({}));
  await invalid.load('apiKeys');
  assert.equal(invalid.read('apiKeys').data, undefined);
  assert.match(invalid.read('apiKeys').error, /invalid API keys/);
});
