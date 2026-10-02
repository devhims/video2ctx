import {
  applyOutcome, healthOrder, normalizedProxyUrls, planProxyOrder, proxyKeys, reportProxyOutcomes,
  PROXY_HEALTH_CACHE_MS, PROXY_HEALTH_LOOKUP_TIMEOUT_MS, PROXY_HEALTH_RETRY_AFTER_FAILURE_MS, type ProxyHealthEntry, type ProxyReport,
} from '../src/lib/proxy-health';
import { createWorkerExtractionRunner, workerProxyUrls, type WorkerExtractionDependencies } from '../src/lib/youtube-worker-extraction';
import { YouTubeProcessorError, runYouTubeOperation, type YouTubeOperation } from '../src/lib/youtube-processor-client';
import { frameProxyOutcomes, getVideoFrames } from '../src/lib/youtube-frames';
import type { Transcript } from 'all-things-youtube';

const MINUTE = 60_000;
const urlA = 'http://user:secret@proxy-a.example:10001/';
const urlB = 'http://user:secret@proxy-b.example:10002/';

/** In-memory stand-in for the Durable Object, using the real cooldown policy. */
function fakeHealth(initial: Record<string, ProxyHealthEntry> = {}, options: { lookup?: (keys: string[]) => Promise<Record<string, ProxyHealthEntry>> } = {}) {
  const store = new Map(Object.entries(initial));
  const reports: ProxyReport[] = [];
  const stub = {
    lookup: vi.fn(options.lookup ?? (async (keys: string[]) => Object.fromEntries(keys.filter(key => store.has(key)).map(key => [key, store.get(key)!])))),
    report: vi.fn(async (batch: ProxyReport[]) => {
      reports.push(...batch);
      for (const { key, outcome } of batch) store.set(key, applyOutcome(store.get(key), outcome, Date.now()));
    }),
  };
  // A fresh binding object per fake, so the per-isolate cache never leaks between tests.
  return { store, reports, stub, binding: { getByName: () => stub } as unknown as Env['PROXY_HEALTH'] };
}

function cooling(now = Date.now()): ProxyHealthEntry {
  return { ...applyOutcome(undefined, 'route_failure', now - 1000), until: now + 10 * MINUTE };
}

/** Pin the random primary slot to 0 so tests can choose which proxy goes first. */
function primaryZero() {
  return vi.spyOn(crypto, 'getRandomValues').mockImplementation(array => { (array as Uint32Array).fill(0); return array; });
}

beforeEach(() => { vi.spyOn(console, 'info').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('cooldown policy', () => {
  const now = 1_000_000_000;
  test('a route failure cools for 2 minutes and doubles when it fails again after recovering', () => {
    const first = applyOutcome(undefined, 'route_failure', now);
    expect(first).toMatchObject({ strikes: 1, until: now + 2 * MINUTE, routeFailures: 1, lastOutcome: 'route_failure' });
    const second = applyOutcome(first, 'route_failure', now + 3 * MINUTE);
    expect(second).toMatchObject({ strikes: 2, until: now + 3 * MINUTE + 4 * MINUTE });
  });
  test('failures reported while already cooling do not escalate', () => {
    const first = applyOutcome(undefined, 'route_failure', now);
    const burst = applyOutcome(applyOutcome(first, 'route_failure', now + 1000), 'route_failure', now + 2000);
    expect(burst.strikes).toBe(1);
    expect(burst.until).toBe(now + 2000 + 2 * MINUTE);
    expect(burst.routeFailures).toBe(3);
  });
  test('rate limits cool longer, and both kinds stop at their caps', () => {
    expect(applyOutcome(undefined, 'rate_limited', now).until).toBe(now + 5 * MINUTE);
    let routes: ProxyHealthEntry | undefined; let limits: ProxyHealthEntry | undefined; let t = now;
    for (let i = 0; i < 8; i++) {
      routes = applyOutcome(routes, 'route_failure', t);
      limits = applyOutcome(limits, 'rate_limited', t);
      t = Math.max(routes.until, limits.until) + 1;
      if (t - (routes.lastFailureAt ?? 0) > 30 * MINUTE) t = (routes.lastFailureAt ?? 0) + 29 * MINUTE;
    }
    expect(routes!.until - routes!.lastFailureAt!).toBeLessThanOrEqual(15 * MINUTE);
    expect(limits!.until - limits!.lastFailureAt!).toBeLessThanOrEqual(30 * MINUTE);
  });
  test('a success clears the cooldown and a failure long after starts over', () => {
    const cooled = applyOutcome(applyOutcome(undefined, 'route_failure', now), 'route_failure', now + 3 * MINUTE);
    expect(applyOutcome(cooled, 'success', now + 4 * MINUTE)).toMatchObject({ strikes: 0, until: 0, successes: 1 });
    expect(applyOutcome(cooled, 'route_failure', now + 2 * 60 * MINUTE)).toMatchObject({ strikes: 1 });
  });
});

describe('slot order', () => {
  const now = 5_000;
  test('healthy slots keep the random rotation and cooling slots go last by recovery time', () => {
    const entries = [{ until: now + 300 }, undefined, { until: now + 100 }, undefined] as Array<ProxyHealthEntry | undefined>;
    expect(healthOrder(4, 1, entries, now)).toEqual([1, 3, 2, 0]);
    expect(healthOrder(4, 1, [], now)).toEqual([1, 2, 3, 0]);
  });
  test('a fully cooling pool is still tried, closest to recovery first', () => {
    const entries = [{ until: now + 3 }, { until: now + 1 }, { until: now + 2 }] as ProxyHealthEntry[];
    expect(healthOrder(3, 0, entries, now)).toEqual([1, 2, 0]);
  });
});

describe('proxy identity', () => {
  test('keys are stable, distinct, and contain nothing from the URL', async () => {
    const [a, b] = await proxyKeys([urlA, urlB]);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(a).not.toBe(b);
    expect((await proxyKeys([urlA]))[0]).toBe(a);
    expect(a).not.toContain('secret');
  });
  test('every path normalizes the pool the same way', () => {
    const env = { OUTBOUND_PROXY_URLS: JSON.stringify(['http://user:secret@proxy-a.example:10001', urlB]) } as unknown as Env;
    expect(normalizedProxyUrls(env)).toEqual(workerProxyUrls(env));
    expect(normalizedProxyUrls({ OUTBOUND_PROXY_URLS: 'not-json' } as unknown as Env)).toBeUndefined();
    expect(normalizedProxyUrls({ OUTBOUND_PROXY_URLS: JSON.stringify([urlA, urlA]) } as unknown as Env)).toBeUndefined();
  });
});

describe('plan and report', () => {
  test('a cooling proxy is planned last', async () => {
    const [keyA] = await proxyKeys([urlA, urlB]);
    const health = fakeHealth({ [keyA!]: cooling() });
    for (let i = 0; i < 6; i++) {
      const plan = await planProxyOrder({ PROXY_HEALTH: health.binding }, [urlA, urlB]);
      expect(plan).toMatchObject({ informed: true, order: [1, 0] });
    }
  });
  test('a slow or missing health object falls back to the random rotation quickly', async () => {
    const slow = fakeHealth({}, { lookup: () => new Promise<never>(() => {}) });
    const started = Date.now();
    const plan = await planProxyOrder({ PROXY_HEALTH: slow.binding }, [urlA, urlB]);
    expect(plan.informed).toBe(false);
    expect(Date.now() - started).toBeLessThan(PROXY_HEALTH_LOOKUP_TIMEOUT_MS + 200);
    expect(new Set(plan.order)).toEqual(new Set([0, 1]));
    await expect(planProxyOrder({} as Env, [urlA])).resolves.toMatchObject({ informed: false, order: [0] });
  });
  test('only successes that clear something are written, and failures always are', async () => {
    const [keyA, keyB] = await proxyKeys([urlA, urlB]);
    const health = fakeHealth({ [keyA!]: cooling() });
    const plan = await planProxyOrder({ PROXY_HEALTH: health.binding }, [urlA, urlB]);
    await reportProxyOutcomes({ PROXY_HEALTH: health.binding }, plan, [{ slot: 1, outcome: 'success' }]);
    expect(health.reports).toEqual([]);
    await reportProxyOutcomes({ PROXY_HEALTH: health.binding }, plan, [{ slot: 0, outcome: 'success' }, { slot: 1, outcome: 'route_failure' }]);
    expect(health.reports).toEqual([{ key: keyA, outcome: 'success' }, { key: keyB, outcome: 'route_failure' }]);
    expect(health.store.get(keyA!)).toMatchObject({ strikes: 0, until: 0 });
  });
  test('an uninformed plan skips successes and a failing report never throws', async () => {
    const health = fakeHealth();
    const plan = await planProxyOrder({} as Env, [urlA]);
    await reportProxyOutcomes({ PROXY_HEALTH: health.binding }, { ...plan, keys: await proxyKeys([urlA]) }, [{ slot: 0, outcome: 'success' }]);
    expect(health.reports).toEqual([]);
    await expect(reportProxyOutcomes({} as Env, { ...plan, keys: await proxyKeys([urlA]) }, [{ slot: 0, outcome: 'route_failure' }])).resolves.toBeUndefined();
  });
});

describe('isolate cache', () => {
  test('lookups are reused for the cache window, then refreshed', async () => {
    const health = fakeHealth();
    const env = { PROXY_HEALTH: health.binding };
    const now = Date.now();
    expect((await planProxyOrder(env, [urlA, urlB], now)).source).toBe('object');
    expect((await planProxyOrder(env, [urlA, urlB], now + 1000)).source).toBe('cache');
    expect(health.stub.lookup).toHaveBeenCalledTimes(1);
    expect((await planProxyOrder(env, [urlA, urlB], Date.now() + PROXY_HEALTH_CACHE_MS + 1)).source).toBe('object');
    expect(health.stub.lookup).toHaveBeenCalledTimes(2);
  });
  test('a failed lookup pauses calls to the object, and reports stay local meanwhile', async () => {
    const health = fakeHealth({}, { lookup: async () => { throw new Error('overloaded'); } });
    const env = { PROXY_HEALTH: health.binding };
    const first = await planProxyOrder(env, [urlA, urlB]);
    expect(first).toMatchObject({ source: 'fallback', informed: false });
    await planProxyOrder(env, [urlA, urlB]);
    expect(health.stub.lookup).toHaveBeenCalledTimes(1);
    await reportProxyOutcomes(env, first, [{ slot: 0, outcome: 'route_failure' }]);
    expect(health.stub.report).not.toHaveBeenCalled();
    // The local record still steers this isolate away from the proxy it saw fail.
    expect(await planProxyOrder(env, [urlA, urlB])).toMatchObject({ source: 'cache', order: [1, 0] });
    await planProxyOrder(env, [urlA, urlB], Date.now() + PROXY_HEALTH_RETRY_AFTER_FAILURE_MS + 1);
    expect(health.stub.lookup).toHaveBeenCalledTimes(2);
  });
  test('a reported failure applies to this isolate at once, without waiting for the next lookup', async () => {
    const health = fakeHealth();
    const env = { PROXY_HEALTH: health.binding };
    const plan = await planProxyOrder(env, [urlA, urlB]);
    await reportProxyOutcomes(env, plan, [{ slot: 0, outcome: 'route_failure' }]);
    for (let i = 0; i < 4; i++) expect(await planProxyOrder(env, [urlA, urlB])).toMatchObject({ source: 'cache', order: [1, 0] });
    expect(health.stub.lookup).toHaveBeenCalledTimes(1);
  });
});

describe('Worker extraction', () => {
  const operation = { kind: 'transcript', id: 'abcdefghijk', granularity: 'word', lang: 'fr' } as const;
  const transcript = { text: 'Recovered', segments: [{ text: 'Recovered' }] } as Transcript;
  const env = (health: ReturnType<typeof fakeHealth>) => ({
    OUTBOUND_PROXY_URLS: JSON.stringify([urlA, urlB]), YOUTUBE_EXTRACTION_RETRY_BASE_MS: '0', PROXY_HEALTH: health.binding,
  }) as unknown as Env;
  // execute makes one YouTube request through the attempt's proxy, like a player call.
  const execute: WorkerExtractionDependencies['execute'] = async (_op, fetchImpl) => {
    const response = await fetchImpl('https://www.youtube.com/youtubei/v1/player');
    if (response.status === 429) throw new YouTubeProcessorError('RATE_LIMITED', 'Rate limited', 429, true);
    return transcript;
  };
  function runner(behaviour: (url: string) => Promise<Response>) {
    const proxyTransport = vi.fn((url: string) => ({ fetch: (() => behaviour(url)) as unknown as typeof fetch, close: async () => {} }));
    return { run: createWorkerExtractionRunner({ execute, proxyTransport }), proxyTransport };
  }

  test('a proxy that cannot connect is recorded, and the next operation tries it last', async () => {
    const health = fakeHealth();
    const [keyA] = await proxyKeys([urlA, urlB]);
    const { run, proxyTransport } = runner(async url => {
      if (url === urlA) throw new TypeError('proxy tunnel failed');
      return Response.json({});
    });
    const random = primaryZero();
    await expect(run(env(health), operation)).resolves.toBe(transcript);
    expect(proxyTransport.mock.calls.map(call => call[0])).toEqual([urlA, urlB]);
    expect(health.reports).toEqual([{ key: keyA, outcome: 'route_failure' }]);
    expect(health.store.get(keyA!)!.until).toBeGreaterThan(Date.now() + MINUTE);

    // The random primary still points at slot 0, but the cooling proxy now goes last.
    proxyTransport.mockClear();
    await expect(run(env(health), operation)).resolves.toBe(transcript);
    expect(proxyTransport.mock.calls.map(call => call[0])).toEqual([urlB]);
    random.mockRestore();
  });

  test('a 429 starts a longer rate-limit cooldown', async () => {
    const health = fakeHealth();
    const [keyA] = await proxyKeys([urlA, urlB]);
    const { run } = runner(async url => new Response('', { status: url === urlA ? 429 : 200 }));
    primaryZero();
    await expect(run(env(health), operation)).resolves.toBe(transcript);
    expect(health.reports).toEqual([{ key: keyA, outcome: 'rate_limited' }]);
    expect(health.store.get(keyA!)!.until).toBeGreaterThan(Date.now() + 4 * MINUTE);
  });

  test('a video-level answer counts as the proxy working and clears its strikes', async () => {
    const [keyA] = await proxyKeys([urlA, urlB]);
    const expired = { ...applyOutcome(undefined, 'route_failure', Date.now() - 10 * MINUTE) };
    const health = fakeHealth({ [keyA!]: expired });
    const notFound: WorkerExtractionDependencies['execute'] = async (_op, fetchImpl) => {
      await fetchImpl('https://www.youtube.com/youtubei/v1/player');
      throw new YouTubeProcessorError('NOT_FOUND', 'No such video', 404, false);
    };
    const run = createWorkerExtractionRunner({ execute: notFound, proxyTransport: () => ({ fetch: (async () => Response.json({})) as unknown as typeof fetch, close: async () => {} }) });
    primaryZero();
    await expect(run(env(health), operation)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(health.reports).toEqual([{ key: keyA, outcome: 'success' }]);
    expect(health.store.get(keyA!)).toMatchObject({ strikes: 0 });
  });

  test('extraction works unchanged when the health object is unreachable', async () => {
    const { run } = runner(async () => Response.json({}));
    const unreachable = { getByName: () => { throw new Error('binding missing'); } } as unknown as Env['PROXY_HEALTH'];
    await expect(run({ OUTBOUND_PROXY_URLS: JSON.stringify([urlA, urlB]), PROXY_HEALTH: unreachable } as unknown as Env, operation)).resolves.toBe(transcript);
  });
});

describe('frames', () => {
  test('outcomes come from the container proxy events', () => {
    expect(frameProxyOutcomes([
      { stage: 'proxy', proxySlot: 2, attempt: 1 }, { stage: 'proxy', proxySlot: 2, attempt: 1, code: 'PROXY_TUNNEL_FAILED' },
      { stage: 'proxy', proxySlot: 0, attempt: 2 }, { stage: 'ffmpeg_success' },
    ], true)).toEqual([{ slot: 2, outcome: 'route_failure' }, { slot: 0, outcome: 'success' }]);
    expect(frameProxyOutcomes([{ stage: 'proxy', proxySlot: 1, attempt: 1 }], false, 'RATE_LIMITED')).toEqual([{ slot: 1, outcome: 'rate_limited' }]);
    expect(frameProxyOutcomes([{ stage: 'proxy', proxySlot: 1, attempt: 1 }], false, 'MEDIA_UNAVAILABLE')).toEqual([]);
  });

  test('the Worker sends the health order and records a failed route from diagnostics', async () => {
    const [keyA] = await proxyKeys([urlA, urlB]);
    const health = fakeHealth({ [keyA!]: cooling() });
    const headers: Array<string | null> = [];
    const fetch = vi.fn(async (request: Request) => {
      headers.push(request.headers.get('x-proxy-order'));
      return Response.json({ value: { videoId: 'abcdefghijk', frames: [{ timestampMs: 1000, mimeType: 'image/jpeg', width: 640, height: 360, imageBase64: '/9j/2Q==' }], failures: [], meta: { partial: false, warnings: [] } },
        diagnostics: { version: 1, droppedEvents: 0, events: [
          { stage: 'proxy', proxySlot: 1, attempt: 1 }, { stage: 'proxy', proxySlot: 1, attempt: 1, code: 'PROXY_TUNNEL_FAILED' },
          { stage: 'proxy', proxySlot: 0, attempt: 2 }] } });
    });
    const env = { OUTBOUND_PROXY_URLS: JSON.stringify([urlA, urlB]), PROXY_HEALTH: health.binding,
      YOUTUBE_FRAMES: { idFromName: (name: string) => name, get: () => ({ fetch }) } } as unknown as Env;
    await expect(getVideoFrames(env, { videoId: 'abcdefghijk', timestampsMs: [1000], maxWidth: 640 })).resolves.toBeDefined();
    expect(headers).toEqual(['1,0']);
    const [, keyB] = await proxyKeys([urlA, urlB]);
    expect(health.reports).toEqual([{ key: keyB, outcome: 'route_failure' }, { key: keyA, outcome: 'success' }]);
  });
});

describe('storyboards', () => {
  test('the egress order puts a cooling proxy last', async () => {
    const urls = ['http://a.test/', 'http://b.test/', 'http://c.test/', 'http://d.test/'];
    const keys = await proxyKeys(urls);
    const health = fakeHealth({ [keys[0]!]: cooling() });
    const egress: string[] = [];
    const env = {
      YOUTUBE_PROCESSOR_INSTANCE_COUNT: '2', YOUTUBE_PROCESSOR_VERSION: 'test-v1', YOUTUBE_PROCESSOR_MAX_ATTEMPTS: '4',
      YOUTUBE_PROCESSOR_RETRY_BASE_MS: '0', YOUTUBE_PROCESSOR_TIMEOUT_MS: '5000', OUTBOUND_PROXY_URLS: JSON.stringify(urls), PROXY_HEALTH: health.binding,
      YOUTUBE_PROCESSOR: { idFromName: (name: string) => name, get: () => ({ fetch: async (request: Request) => {
        egress.push(request.headers.get('x-processor-egress-slot')!);
        return Response.json({ error: { code: 'UNAVAILABLE', retryable: true } }, { status: 503 });
      } }) },
    } as unknown as Env;
    primaryZero();
    await expect(runYouTubeOperation(env, { kind: 'storyboard', id: 'abcdefghijk' } as YouTubeOperation)).rejects.toBeDefined();
    expect(egress).toEqual(['1', '2', '3', '0']);
    // Ambiguous processor failures are not reported against the proxy.
    expect(health.reports).toEqual([]);
  });
});
