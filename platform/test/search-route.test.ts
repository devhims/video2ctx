vi.mock('cloudflare:workers', () => ({ WorkflowEntrypoint: class {} }));

import { app } from '../src/index';
import { sha256 } from '../src/lib/http';

describe('YouTube search route', () => {
  test('includes the continuation token in the cached search request', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bindings: unknown[][] = [];
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
      DB: {
        prepare: vi.fn(() => ({
          bind: (...values: unknown[]) => {
            bindings.push(values);
            return {
              first: async () => ({
                data_json: JSON.stringify(cachedResponse),
                fetched_at: Date.now(),
                expires_at: Date.now() + 60_000,
              }),
            };
          },
        })),
      },
    } as unknown as Env;

    const response = await app.request(
      '/v1/search?q=research&type=all&continuation=NEXT_SEARCH_PAGE',
      {},
      env,
      { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext,
    );
    const expectedKey = await sha256(JSON.stringify({
      query: 'research',
      filters: { type: 'all', continuation: 'NEXT_SEARCH_PAGE' },
    }));

    expect(response.status).toBe(200);
    expect(bindings[0]).toEqual(['search-v2', expectedKey]);
    warning.mockRestore();
  });
});
