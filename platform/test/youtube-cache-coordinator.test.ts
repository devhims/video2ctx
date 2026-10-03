import { readYouTubeCacheEntry, YouTubeCacheCoordinatorCore } from '../src/lib/youtube-cache-coordinator';
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
  const blocked = {
    id: 'abcdefghijk', availability: { status: 'LOGIN_REQUIRED', reason: 'Sign in to confirm you’re not a bot' },
    meta: { partial: true },
  };

  test('preserves the last good metadata and its timestamp when refresh returns a bot challenge', async () => {
    const fetchedAt = Date.now() - 120_000;
    const value = { id: 'abcdefghijk', viewCount: 404433 };
    const cache = { get: vi.fn(async () => ({ version: 1, value, fetchedAt, freshUntil: Date.now() - 60_000 })), put: vi.fn() };
    const coordinator = new YouTubeCacheCoordinatorCore(environment(cache), async () => blocked);
    await expect(coordinator.getOrLoad({ ...request, refresh: true })).resolves.toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } });
    expect(cache.put).not.toHaveBeenCalled();
  });

  test('does not cache bot challenges when there is no usable metadata', async () => {
    const cache = { get: vi.fn(async () => null), put: vi.fn() };
    const loader = vi.fn(async () => blocked);
    const coordinator = new YouTubeCacheCoordinatorCore(environment(cache), loader);
    for (let index = 0; index < 2; index++) {
      await expect(coordinator.getOrLoad(request)).resolves.toMatchObject({ ok: false, error: { code: 'UNAVAILABLE', retryable: true } });
    }
    expect(loader).toHaveBeenCalledTimes(2);
    expect(cache.put).not.toHaveBeenCalled();
  });

  test.each([60_000, -60_000])('ignores previously cached bot challenges with freshness offset %i', async (offset) => {
    const cache = { get: vi.fn(async () => ({ version: 1, value: blocked, fetchedAt: Date.now() - 1000, freshUntil: Date.now() + offset })), put: vi.fn() };
    await expect(readYouTubeCacheEntry(environment(cache), request.cacheKey, 'video')).resolves.toBeNull();
    const loader = vi.fn(async () => ({ id: 'abcdefghijk', viewCount: 404434 }));
    const coordinator = new YouTubeCacheCoordinatorCore(environment(cache), loader);
    await expect(coordinator.getOrLoad(request)).resolves.toMatchObject({ ok: true, cacheStatus: 'miss', value: { viewCount: 404434 } });
    expect(loader).toHaveBeenCalledOnce();
  });

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

  test('serves an expired search response when the shared upstream operation fails', async () => {
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

    await expect(coordinator.getOrLoad({ ...request, resourceType: 'search', operation: { kind: 'search', query: 'video' } })).resolves.toMatchObject({
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

test('coalesces matching or shorter deadlines but gives later callers their own extraction', async () => {
  const resolvers: Array<(value: unknown) => void> = [];
  const loader = vi.fn(() => new Promise(resolve => resolvers.push(resolve)));
  const core = new YouTubeCacheCoordinatorCore(environment({ get: vi.fn(async () => null), put: vi.fn() }), loader);
  const first = { ...request, operation: { ...request.operation, deadlineAt: Date.now() + 10_000 } };
  const second = { ...request, operation: { ...request.operation, deadlineAt: first.operation.deadlineAt + 30_000 } };
  const shorter = { ...first, operation: { ...first.operation, deadlineAt: first.operation.deadlineAt - 5000 } };
  const pending = [core.getOrLoad(first), core.getOrLoad(first), core.getOrLoad(shorter), core.getOrLoad(second)];
  await vi.waitFor(() => expect(loader).toHaveBeenCalledTimes(2));
  resolvers.forEach(resolve => resolve({ id: 'abcdefghijk' }));
  const results = await Promise.all(pending);
  expect(results.map(result => result.cacheStatus)).toEqual(['miss', 'coalesced', 'coalesced', 'miss']);
});

test.each([
  [undefined, 60_000, 1],
  [180_000, undefined, 1],
  [30_000, undefined, 2],
] as const)('shares public and agent work only when the leader has enough time (%s, %s)', async (leaderMs, followerMs, calls) => {
  const resolvers: Array<(value: unknown) => void> = [];
  const loader = vi.fn(() => new Promise(resolve => resolvers.push(resolve)));
  const core = new YouTubeCacheCoordinatorCore(environment({ get: vi.fn(async () => null), put: vi.fn() }), loader);
  const input = (ms?: number) => ({ ...request, operation: { ...request.operation,
    ...(ms === undefined ? {} : { deadlineAt: Date.now() + ms }) } });
  const leader = core.getOrLoad(input(leaderMs));
  await vi.waitFor(() => expect(loader).toHaveBeenCalledOnce());
  const follower = core.getOrLoad(input(followerMs));
  await vi.waitFor(() => expect(loader).toHaveBeenCalledTimes(calls));
  resolvers.forEach(resolve => resolve({ id: 'abcdefghijk' }));
  expect((await Promise.all([leader, follower])).map(result => result.cacheStatus))
    .toEqual(['miss', calls === 1 ? 'coalesced' : 'miss']);
});

test('an expired follower stops waiting without cancelling or removing the shared extraction', async () => {
  vi.useFakeTimers();
  try {
    let complete!: (value: unknown) => void;
    const loader = vi.fn(() => new Promise(resolve => { complete = resolve; }));
    const core = new YouTubeCacheCoordinatorCore(environment({ get: vi.fn(async () => null), put: vi.fn() }), loader);
    const input = (ms: number) => ({ ...request, operation: { ...request.operation, deadlineAt: Date.now() + ms } });
    const leader = core.getOrLoad(input(60_000));
    await vi.waitFor(() => expect(loader).toHaveBeenCalledOnce());
    const follower = core.getOrLoad(input(1000));
    await vi.advanceTimersByTimeAsync(1001);
    expect(await follower).toMatchObject({ ok: false, error: { code: 'EXTRACTION_DEADLINE_EXCEEDED', retryable: true } });
    const next = core.getOrLoad(input(10_000));
    complete({ id: 'abcdefghijk' });
    expect((await Promise.all([leader, next])).map(result => result.cacheStatus)).toEqual(['miss', 'coalesced']);
    expect(loader).toHaveBeenCalledOnce();
  } finally { vi.useRealTimers(); }
});
