import { YouTubeCacheCoordinatorCore } from '../src/lib/youtube-cache-coordinator';
import type { YouTubeOperation } from '../src/lib/youtube-processor-client';

const request = {
  cacheKey: 'youtube:v1:test-key',
  resourceType: 'video',
  maxAgeMs: 60_000,
  operation: { kind: 'video', id: 'abcdefghijk' } satisfies YouTubeOperation,
};

function environment(cache: { get: ReturnType<typeof vi.fn>; put: ReturnType<typeof vi.fn> }): Env {
  return { YOUTUBE_CACHE: cache } as unknown as Env;
}

describe('YouTube cache coordinator', () => {
  test('coalesces simultaneous misses into one upstream operation', async () => {
    let complete: ((value: unknown) => void) | undefined;
    const loader = vi.fn(() => new Promise<unknown>((resolve) => { complete = resolve; }));
    const cache = {
      get: vi.fn(async () => null),
      put: vi.fn(async () => undefined),
    };
    const coordinator = new YouTubeCacheCoordinatorCore(environment(cache), loader);

    const leader = coordinator.getOrLoad(request);
    await vi.waitFor(() => expect(loader).toHaveBeenCalledTimes(1));
    const follower = coordinator.getOrLoad(request);
    complete?.({ id: 'abcdefghijk' });

    await expect(leader).resolves.toMatchObject({ ok: true, cacheStatus: 'miss' });
    await expect(follower).resolves.toMatchObject({ ok: true, cacheStatus: 'coalesced' });
    expect(loader).toHaveBeenCalledTimes(1);
    expect(cache.get).toHaveBeenCalledTimes(1);
    expect(cache.put).toHaveBeenCalledTimes(1);
  });

  test('serves an expired value when the shared upstream operation fails', async () => {
    const cachedValue = { id: 'abcdefghijk' };
    const cache = {
      get: vi.fn(async () => ({
        version: 1,
        value: cachedValue,
        fetchedAt: Date.now() - 120_000,
        freshUntil: Date.now() - 60_000,
      })),
      put: vi.fn(async () => undefined),
    };
    const loader = vi.fn(async () => { throw new Error('upstream unavailable'); });
    const coordinator = new YouTubeCacheCoordinatorCore(environment(cache), loader);

    await expect(coordinator.getOrLoad(request)).resolves.toMatchObject({
      ok: true,
      value: cachedValue,
      cacheStatus: 'stale',
    });
    expect(cache.put).not.toHaveBeenCalled();
  });

  test('rechecks KV and avoids upstream work when another edge already filled the cache', async () => {
    const cache = {
      get: vi.fn(async () => ({
        version: 1,
        value: { id: 'abcdefghijk' },
        fetchedAt: Date.now(),
        freshUntil: Date.now() + 60_000,
      })),
      put: vi.fn(async () => undefined),
    };
    const loader = vi.fn(async () => ({ id: 'unexpected' }));
    const coordinator = new YouTubeCacheCoordinatorCore(environment(cache), loader);

    await expect(coordinator.getOrLoad(request)).resolves.toMatchObject({
      ok: true,
      cacheStatus: 'hit',
    });
    expect(loader).not.toHaveBeenCalled();
  });
});
