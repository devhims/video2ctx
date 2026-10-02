import { Hono } from 'hono';
import { applyOutcome, proxyKeys, type ProxyHealthEntry } from '../src/lib/proxy-health';
import { jsonError } from '../src/lib/http';
import type { App } from '../src/types';

vi.mock('../src/lib/admin-access', () => ({ requireAdminSession: async () => {}, requireAdminMutationOrigin: () => {} }));
const { adminRoutes } = await import('../src/routes/admin/admin.index');

const urls = ['http://user:secret@proxy-a.example:8001/', 'http://user:secret@proxy-b.example:8002/'];

function app() {
  const router = new Hono<App>();
  router.route('/v1', adminRoutes);
  router.onError((error, c) => jsonError(c, error));
  return router;
}

test('admin proxy health lists each slot by host and port without credentials', async () => {
  const [keyA] = await proxyKeys(urls);
  const entries: Record<string, ProxyHealthEntry> = { [keyA!]: applyOutcome(undefined, 'rate_limited', Date.now()) };
  const env = { OUTBOUND_PROXY_URLS: JSON.stringify(urls),
    PROXY_HEALTH: { getByName: () => ({ lookup: async (keys: string[]) => Object.fromEntries(keys.filter(key => entries[key]).map(key => [key, entries[key]])) }) } } as unknown as Env;
  const response = await app().request('/v1/admin/proxy-health', {}, env);
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(text).not.toContain('secret');
  expect(JSON.parse(text).proxies).toEqual([
    expect.objectContaining({ slot: 0, host: 'proxy-a.example', port: '8001', cooling: true, strikes: 1, lastOutcome: 'rate_limited', rateLimited: 1 }),
    expect.objectContaining({ slot: 1, host: 'proxy-b.example', port: '8002', cooling: false, coolingUntil: null, strikes: 0, lastOutcome: null }),
  ]);
});

test('admin proxy health reports an unreachable store as unavailable', async () => {
  const env = { OUTBOUND_PROXY_URLS: JSON.stringify(urls), PROXY_HEALTH: { getByName: () => ({ lookup: async () => { throw new Error('down'); } }) } } as unknown as Env;
  const response = await app().request('/v1/admin/proxy-health', {}, env);
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ error: { code: 'PROXY_HEALTH_UNAVAILABLE' } });
});
