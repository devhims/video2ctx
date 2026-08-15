vi.mock('cloudflare:workers', () => ({ WorkflowEntrypoint: class {}, DurableObject: class {} }));

vi.mock('../src/middlewares/authentication', () => routeAuthenticationMock());
vi.mock('../src/lib/metering', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/metering')>(),
  meterOperation: vi.fn(async (_c, _options, work) => (await work()).value),
}));

import { app } from '../src/index';
import { sha256 } from '../src/lib/http';

describe('provider search route', () => {
  test('includes the continuation token in the cached search request', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const get = vi.fn();
    const cachedResponse = {
      query: 'research',
      results: [],
      videos: [],
      channels: [],
      playlists: [],
      meta: { source: 'allthingsyoutube', fetchedAt: new Date().toISOString(), partial: false, warnings: [] },
    };
    const env = {
      PUBLIC_RATE_LIMITER: { limit: vi.fn(async () => ({ success: true })) },
      YOUTUBE_CACHE: {
        get: get.mockResolvedValue({
          version: 1,
          value: cachedResponse,
          fetchedAt: Date.now(),
          freshUntil: Date.now() + 60_000,
        }),
      },
    } as unknown as Env;

    const response = await app.request(
      '/v1/providers/youtube/search?q=research&type=all&continuation=NEXT_SEARCH_PAGE',
      {},
      env,
      { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext,
    );
    const expectedKey = await sha256(JSON.stringify({
      query: 'research',
      filters: { type: 'all', continuation: 'NEXT_SEARCH_PAGE' },
    }));
    const expectedCacheKey = `youtube:v1:${await sha256(JSON.stringify(['search-v3', expectedKey]))}`;

    expect(response.status).toBe(200);
    expect(get).toHaveBeenCalledWith(expectedCacheKey, { type: 'json', cacheTtl: 60 });
    const payload = await response.json() as Record<string, unknown>;
    expect(payload.results).toEqual([]);
    expect(payload).not.toHaveProperty('videos');
    expect(payload).not.toHaveProperty('channels');
    expect(payload).not.toHaveProperty('playlists');
    warning.mockRestore();
  });
});

function routeAuthenticationMock() {
  const user = { id: 'test-user', email: 'test@example.com', name: 'Test User' };
  const principal = { user, method: 'session' as const, permissions: {} };
  return {
    establishPrincipal: async (c: any, next: () => Promise<void>) => {
      c.set('principal', principal); c.set('user', user); await next();
    },
    requireAccountPrincipal: async (_c: any, next: () => Promise<void>) => next(),
    requireDataPrincipal: async (_c: any, next: () => Promise<void>) => next(),
    requireSessionPrincipal: async (_c: any, next: () => Promise<void>) => next(),
    requirePrincipal: () => principal,
    requireUser: () => user,
  };
}
