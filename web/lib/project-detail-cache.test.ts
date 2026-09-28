import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createProjectDetailCache } from './project-detail-cache.ts';
import type { ProjectDetail } from '../app/dashboard/research-types.ts';

const project = (name = 'Project'): ProjectDetail => ({ id: 'project', name, items: [] });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test('sidebar and page share a read, then reopen from cache without another request', async () => {
  const gate = deferred<ProjectDetail>();
  let calls = 0;
  const cache = createProjectDetailCache(async () => { calls++; return gate.promise; });
  const first = cache.load('project');
  assert.equal(cache.load('project'), first);
  gate.resolve(project());
  await first;
  assert.equal(cache.read('project').data?.name, 'Project');
  await cache.load('project');
  assert.equal(calls, 1);
});

test('mutation invalidation refreshes consumers and prevents an older read from winning', async () => {
  const before = deferred<ProjectDetail>(), after = deferred<ProjectDetail>();
  let calls = 0;
  const cache = createProjectDetailCache(() => ++calls === 1 ? before.promise : after.promise);
  const initial = cache.load('project');
  const refresh = cache.invalidate('project');
  after.resolve(project('After save'));
  await refresh;
  before.resolve(project('Before save'));
  await initial;
  assert.equal(cache.read('project').data?.name, 'After save');
});

test('background refresh keeps visible sources on temporary errors but clears revoked access', async () => {
  let failure: Error | undefined;
  const cache = createProjectDetailCache(async () => { if (failure) throw failure; return project(); });
  await cache.load('project');
  failure = new Error('Temporary outage');
  const refresh = cache.load('project', true);
  assert.equal(cache.read('project').data?.name, 'Project');
  assert.equal(cache.read('project').loading, true);
  await refresh;
  assert.equal(cache.read('project').data?.name, 'Project');
  assert.equal(cache.read('project').error, 'Temporary outage');
  failure = Object.assign(new Error('Not found'), { status: 404 });
  await cache.load('project', true);
  assert.equal(cache.read('project').data, undefined);
});

test('account caches do not share project data', async () => {
  const first = createProjectDetailCache(async () => project());
  const second = createProjectDetailCache(async () => project('Other account'));
  await first.load('project');
  assert.equal(second.read('project').data, undefined);
  await second.load('project');
  assert.equal(first.read('project').data?.name, 'Project');
  assert.equal(second.read('project').data?.name, 'Other account');
});

test('expired sources remain visible while one shared background refresh runs', async context => {
  let now = 100_000, calls = 0;
  context.mock.method(Date, 'now', () => now);
  const updated = deferred<ProjectDetail>();
  const cache = createProjectDetailCache(async () => ++calls === 1 ? project('Original') : updated.promise);
  await cache.load('project');
  now += 60_001;
  const refresh = cache.load('project');
  assert.equal(cache.load('project'), refresh);
  assert.equal(cache.read('project').data?.name, 'Original');
  assert.equal(cache.read('project').loading, true);
  updated.resolve(project('Refreshed'));
  await refresh;
  assert.equal(cache.read('project').data?.name, 'Refreshed');
  assert.equal(calls, 2);
});
