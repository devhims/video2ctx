import { createWorkerExtractionRunner, ROUTE_FIRST_RESPONSE_TIMEOUT_MS, workerProxyUrls, type WorkerExtractionDependencies } from '../src/lib/youtube-worker-extraction';
import { executeWorkerYouTubeOperation, type WorkerYouTubeResult } from '../src/lib/youtube-worker-runtime';
import { YouTubeProcessorError, runYouTubeOperation } from '../src/lib/youtube-processor-client';
import type { Transcript, CaptionTrackList } from 'all-things-youtube';
import type { ExtractionAttempt } from '../src/lib/extraction-diagnostics';

const operation = { kind: 'transcript', id: 'abcdefghijk', granularity: 'word', lang: 'fr' } as const;
const transcript = { text: 'Recovered', segments: [{ text: 'Recovered' }] } as Transcript;
const unavailable = () => new YouTubeProcessorError('UNAVAILABLE', 'Upstream unavailable', 503, true);
const env = (overrides: Record<string, string> = {}) => ({
  OUTBOUND_PROXY_URLS: '["http://user:secret@proxy-a.example:10001","http://user:secret@proxy-b.example:10002"]',
  YOUTUBE_EXTRACTION_RETRY_BASE_MS: '0', ...overrides,
}) as unknown as Env;

function harness(execute: WorkerExtractionDependencies['execute']) {
  const close = vi.fn(async () => {});
  const proxyFetch = vi.fn<typeof fetch>(async () => Response.json({}));
  const proxyTransport = vi.fn((_url: string) => ({ fetch: proxyFetch, close }));
  const run = createWorkerExtractionRunner({ execute, proxyTransport });
  return { run, proxyFetch, proxyTransport, close };
}

beforeEach(() => { vi.spyOn(console, 'info').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

test('first attempt uses a proxy and returns the same result with safe diagnostics', async () => {
  const execute = vi.fn(async () => transcript);
  const { run, proxyTransport } = harness(execute);
  const diagnostic = vi.fn();
  expect(await run(env(), operation, diagnostic)).toBe(transcript);
  expect(proxyTransport).toHaveBeenCalledTimes(1);
  expect(diagnostic).toHaveBeenCalledWith(expect.objectContaining({ backend: 'worker', egress: 'proxy', attempt: 1, outcome: 'success' }));
});

test('whole-operation fallback visits each proxy before repeating, including a fourth attempt', async () => {
  const execute = vi.fn<WorkerExtractionDependencies['execute']>().mockRejectedValueOnce(unavailable()).mockRejectedValueOnce(unavailable()).mockRejectedValueOnce(unavailable()).mockResolvedValue(transcript);
  const { run, proxyTransport, close } = harness(execute);
  const diagnostics: ExtractionAttempt[] = [];
  await expect(run(env(), operation, event => diagnostics.push(event))).resolves.toBe(transcript);
  expect(execute).toHaveBeenCalledTimes(4);
  for (const [op] of execute.mock.calls) expect(op).toBe(operation);
  const urls = proxyTransport.mock.calls.map(call => call[0]);
  expect(urls[0]).not.toEqual(urls[1]);
  expect(urls[2]).toEqual(urls[0]); expect(urls[3]).toEqual(urls[1]);
  expect(close).toHaveBeenCalledTimes(4);
  expect(diagnostics).toHaveLength(4);
  expect(diagnostics.at(-1)).toMatchObject({ attempt: 4, outcome: 'success', egress: 'proxy' });
});

test.each(['INVALID_INPUT', 'AUTH_REQUIRED', 'REGION_RESTRICTED'] as const)('%s is terminal even when marked retryable', async code => {
  const { run, proxyTransport } = harness(async () => { throw new YouTubeProcessorError(code, 'private secret', 400, true); });
  await expect(run(env(), operation)).rejects.toMatchObject({ code });
  expect(proxyTransport).toHaveBeenCalledTimes(1);
});

test('missing proxy configuration fails before extraction or network access', async () => {
  const execute = vi.fn(async () => transcript);
  const { run, proxyTransport } = harness(execute);
  const native = vi.spyOn(globalThis, 'fetch');
  await expect(run(env({ OUTBOUND_PROXY_URLS: '' }), operation)).rejects.toMatchObject({ code: 'PROCESSOR_UNAVAILABLE' });
  expect(execute).not.toHaveBeenCalled();
  expect(proxyTransport).not.toHaveBeenCalled();
  expect(native).not.toHaveBeenCalled();
});

test('an earlier upstream error is not overwritten by a later transcript NOT_FOUND', async () => {
  const execute = vi.fn<WorkerExtractionDependencies['execute']>()
    .mockRejectedValueOnce(new YouTubeProcessorError('RATE_LIMITED', 'rate limit', 429, true))
    .mockRejectedValue(new YouTubeProcessorError('NOT_FOUND', 'missing', 404));
  const { run } = harness(execute);
  await expect(run(env(), operation)).rejects.toMatchObject({ code: 'RATE_LIMITED', status: 429 });
});

test('confirmed empty caption catalogs survive sanitization and an earlier proxy outage', async () => {
  let calls = 0;
  const playable = { playabilityStatus: { status: 'OK' }, videoDetails: { videoId: operation.id } };
  const proxyFetch: typeof fetch = async input => String(input).includes('/watch?')
    ? new Response(`var ytInitialPlayerResponse = ${JSON.stringify(playable)};`)
    : Response.json(playable);
  const execute: WorkerExtractionDependencies['execute'] = async (op, fetchImpl) => {
    if (++calls === 1) throw unavailable();
    return executeWorkerYouTubeOperation(op, fetchImpl);
  };
  const run = createWorkerExtractionRunner({ execute, proxyTransport: () => ({ fetch: proxyFetch, close: async () => {} }) });
  await expect(run(env(), operation)).rejects.toMatchObject({ code: 'CAPTIONS_UNAVAILABLE', retryable: false });
  expect(calls).toBe(2);
});

test('partial track catalogs visit each distinct route only once', async () => {
  const partial = { tracks: [], meta: { partial: true } } as unknown as CaptionTrackList;
  const execute = vi.fn(async () => partial);
  const { run } = harness(execute);
  await expect(run(env(), { kind: 'caption-tracks', id: operation.id })).resolves.toBe(partial);
  expect(execute).toHaveBeenCalledTimes(2);
});

test('bot-challenged metadata falls back but legitimate restricted metadata does not', async () => {
  const blocked = { availability: { status: 'LOGIN_REQUIRED', reason: 'Sign in to confirm you are not a bot' } } as WorkerYouTubeResult;
  const valid = { id: operation.id, availability: { status: 'OK' } } as WorkerYouTubeResult;
  const execute = vi.fn<WorkerExtractionDependencies['execute']>().mockResolvedValueOnce(blocked).mockResolvedValue(valid);
  const { run } = harness(execute);
  await expect(run(env(), { kind: 'video', id: operation.id })).resolves.toBe(valid);
  expect(execute).toHaveBeenCalledTimes(2);
  const restricted = { availability: { status: 'LOGIN_REQUIRED', reason: 'This video is private' } } as WorkerYouTubeResult;
  const restrictedHarness = harness(async () => restricted);
  await expect(restrictedHarness.run(env(), { kind: 'video', id: operation.id })).resolves.toBe(restricted);
  expect(restrictedHarness.proxyTransport).toHaveBeenCalledTimes(1);
});

test('timeouts cover body reads and use a fresh proxy attempt', async () => {
  vi.useFakeTimers();
  const execute = vi.fn<WorkerExtractionDependencies['execute']>(async (_op, fetchImpl) => {
    await fetchImpl('https://www.youtube.com/api/timedtext'); return transcript;
  });
  const { run, proxyFetch, proxyTransport } = harness(execute);
  proxyFetch.mockImplementationOnce(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])); } })));
  const result = run(env({ YOUTUBE_PROXY_TIMEOUT_MS: '100' }), operation);
  await vi.advanceTimersByTimeAsync(105);
  await expect(result).resolves.toBe(transcript);
  expect(proxyTransport).toHaveBeenCalledTimes(2);
});

test('ignoring fetch cancellation cannot hold a proxy attempt forever', async () => {
  vi.useFakeTimers();
  const execute = vi.fn<WorkerExtractionDependencies['execute']>(async (_op, fetchImpl) => { await fetchImpl('https://www.youtube.com/api/timedtext'); return transcript; });
  const { run, proxyFetch } = harness(execute);
  proxyFetch.mockImplementationOnce(() => new Promise(() => {}));
  const pending = run(env({ YOUTUBE_PROXY_TIMEOUT_MS: '100' }), operation);
  await vi.advanceTimersByTimeAsync(105);
  await expect(pending).resolves.toBe(transcript);
});

test('Retry-After waits are bounded by the total operation deadline', async () => {
  vi.useFakeTimers();
  const execute = vi.fn<WorkerExtractionDependencies['execute']>(async (_op, fetchImpl) => { await fetchImpl('https://www.youtube.com/watch'); throw unavailable(); });
  const { run, proxyFetch, proxyTransport } = harness(execute);
  proxyFetch.mockResolvedValue(new Response('', { status: 429, headers: { 'retry-after': '60' } }));
  const pending = run(env({ YOUTUBE_EXTRACTION_TIMEOUT_MS: '1000' }), operation);
  const rejected = expect(pending).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  await vi.advanceTimersByTimeAsync(1001);
  await rejected;
  expect(proxyTransport).toHaveBeenCalledTimes(1);
});

test('canceling an operation prevents later routes', async () => {
  const controller = new AbortController();
  const { run, proxyTransport } = harness(async () => { controller.abort(); throw unavailable(); });
  await expect(run(env(), operation, undefined, controller.signal)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  expect(proxyTransport).toHaveBeenCalledTimes(1);
});

test('oversized upstream bodies fail before reaching the parser', async () => {
  const { run, proxyFetch } = harness(async (_op, fetchImpl) => { await fetchImpl('https://www.youtube.com/watch'); return transcript; });
  proxyFetch.mockImplementation(async () => new Response(new Uint8Array(8 * 1024 * 1024 + 1)));
  await expect(run(env({ YOUTUBE_PROXY_MAX_ATTEMPTS: '1' }), operation)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
});

test('raw transport errors cannot disclose URLs, credentials or nested causes', async () => {
  const { run } = harness(async () => { throw new Error('http://user:secret@proxy-a.example signed?token=secret', { cause: new Error('secret') }); });
  const sink = vi.fn();
  try { await run(env({ YOUTUBE_PROXY_MAX_ATTEMPTS: '1' }), operation, sink); throw new Error('expected failure'); }
  catch (error) { expect(String(error)).not.toContain('secret'); }
  expect(JSON.stringify(sink.mock.calls)).not.toContain('secret');
  expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain('secret');
});

test('proxy cleanup errors and diagnostic sinks cannot turn success into failure', async () => {
  const execute = vi.fn<WorkerExtractionDependencies['execute']>().mockRejectedValueOnce(unavailable()).mockResolvedValue(transcript);
  const { run, close } = harness(execute);
  close.mockRejectedValue(new Error('private transport error'));
  await expect(run(env(), operation, () => { throw new Error('sink'); })).resolves.toBe(transcript);
});

test('single URL fallback and malformed pool handling do not expose credentials', () => {
  expect(workerProxyUrls({ OUTBOUND_PROXY_URL: 'http://user:secret@proxy.test:10001' })).toHaveLength(1);
  expect(() => workerProxyUrls({ OUTBOUND_PROXY_URLS: '[secret' })).toThrow('proxy configuration is invalid');
  expect(() => workerProxyUrls({ OUTBOUND_PROXY_URLS: '[]' })).toThrow();
  expect(() => workerProxyUrls({ OUTBOUND_PROXY_URL: 'socks5://user:secret@proxy.test:1' })).toThrow();
  expect(() => workerProxyUrls({ OUTBOUND_PROXY_URLS: '["http://a.test", "http://a.test/"]' })).toThrow();
});

test('actual library keeps source metadata and caption download on the same proxy transport', async () => {
  const nativeFetch = vi.spyOn(globalThis, 'fetch');
  const captionRequests: string[] = [];
  const proxyFetch: typeof fetch = async input => {
    const url = String(input);
    if (url.includes('/watch?')) return new Response('', { status: 404 });
    if (url.includes('/player')) return Response.json({ playabilityStatus: { status: 'OK' }, captions: {
      playerCaptionsTracklistRenderer: { captionTracks: [{ baseUrl: 'https://captions.test/en', languageCode: 'en', vssId: '.en', isTranslatable: true }], translationLanguages: [{ languageCode: 'fr', languageName: { simpleText: 'French' } }] },
    } });
    captionRequests.push(url);
    return Response.json({ events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'Bonjour' }] }] });
  };
  const close = vi.fn(async () => {});
  const run = createWorkerExtractionRunner({ execute: executeWorkerYouTubeOperation, proxyTransport: () => ({ fetch: proxyFetch, close }) });
  await expect(run(env(), operation)).resolves.toMatchObject({ text: 'Bonjour', translatedTo: { languageCode: 'fr' } });
  expect(nativeFetch).not.toHaveBeenCalled();
  expect(captionRequests).toEqual(['https://captions.test/en?fmt=json3&tlang=fr']);
  expect(close).toHaveBeenCalledOnce();
});

test('Worker switch leaves storyboard on the container path', async () => {
  const bindingFetch = vi.fn(async () => Response.json({ value: { sheets: [] } }));
  const environment = { ...env(), YOUTUBE_EXTRACTION_BACKEND: 'worker', YOUTUBE_PROCESSOR: { idFromName: (s: string) => s, get: () => ({ fetch: bindingFetch }) } } as unknown as Env;
  await expect(runYouTubeOperation(environment, { kind: 'storyboard', id: operation.id })).resolves.toEqual({ sheets: [] });
  expect(bindingFetch).toHaveBeenCalledOnce();
});


test('a stalled transport close cannot hold the operation indefinitely', async () => {
  vi.useFakeTimers();
  const execute = vi.fn<WorkerExtractionDependencies['execute']>().mockResolvedValue(transcript);
  const { run, close } = harness(execute);
  close.mockImplementation(() => new Promise(() => {}));
  const pending = run(env(), operation);
  await vi.advanceTimersByTimeAsync(1001);
  await expect(pending).resolves.toBe(transcript);
});

test('a route that never answers moves to the next proxy after the first-response deadline', async () => {
  vi.useFakeTimers();
  let calls = 0;
  const execute = vi.fn<WorkerExtractionDependencies['execute']>(async (_op, fetchImpl) => {
    // A library retry on the stalled route must fail at once, not wait again.
    try { await fetchImpl('https://www.youtube.com/youtubei/v1/player'); }
    catch { await fetchImpl('https://www.youtube.com/youtubei/v1/player'); }
    return transcript;
  });
  const { run, proxyFetch, proxyTransport } = harness(execute);
  proxyFetch.mockImplementation(async () => { calls++; return calls === 1 ? new Promise<Response>(() => {}) : Response.json({}); });
  const diagnostics: ExtractionAttempt[] = [];
  const pending = run(env(), operation, event => diagnostics.push(event));
  await vi.advanceTimersByTimeAsync(ROUTE_FIRST_RESPONSE_TIMEOUT_MS + 50);
  await expect(pending).resolves.toBe(transcript);
  expect(proxyTransport).toHaveBeenCalledTimes(2);
  expect(proxyTransport.mock.calls[0]![0]).not.toEqual(proxyTransport.mock.calls[1]![0]);
  expect(calls).toBe(2);
  expect(diagnostics[0]).toMatchObject({ attempt: 1, outcome: 'fallback', failureKind: 'timeout' });
});

test('the first-response deadline ends once the route answers and is off on the last route', async () => {
  vi.useFakeTimers();
  const slowSecond = vi.fn<WorkerExtractionDependencies['execute']>(async (_op, fetchImpl) => {
    await fetchImpl('https://www.youtube.com/a');
    await fetchImpl('https://www.youtube.com/b');
    return transcript;
  });
  const first = harness(slowSecond);
  let call = 0;
  first.proxyFetch.mockImplementation(async () => {
    call++;
    if (call === 2) await new Promise(resolve => setTimeout(resolve, ROUTE_FIRST_RESPONSE_TIMEOUT_MS * 2));
    return Response.json({});
  });
  const answered = first.run(env(), operation);
  await vi.advanceTimersByTimeAsync(ROUTE_FIRST_RESPONSE_TIMEOUT_MS * 2 + 50);
  await expect(answered).resolves.toBe(transcript);
  expect(first.proxyTransport).toHaveBeenCalledTimes(1);

  const only = harness(async (_op, fetchImpl) => { await fetchImpl('https://www.youtube.com/a'); return transcript; });
  only.proxyFetch.mockImplementation(async () => {
    await new Promise(resolve => setTimeout(resolve, ROUTE_FIRST_RESPONSE_TIMEOUT_MS * 2));
    return Response.json({});
  });
  const last = only.run(env({ YOUTUBE_PROXY_MAX_ATTEMPTS: '1' }), operation);
  await vi.advanceTimersByTimeAsync(ROUTE_FIRST_RESPONSE_TIMEOUT_MS * 2 + 50);
  await expect(last).resolves.toBe(transcript);
});

test('a slow concurrent request is not cut short once another request on the route has answered', async () => {
  vi.useFakeTimers();
  const execute = vi.fn<WorkerExtractionDependencies['execute']>(async (_op, fetchImpl) => {
    // Transcript metadata issues player and desktop requests concurrently.
    await Promise.all([fetchImpl('https://www.youtube.com/youtubei/v1/player'), fetchImpl('https://www.youtube.com/watch')]);
    return transcript;
  });
  const { run, proxyFetch, proxyTransport } = harness(execute);
  proxyFetch.mockImplementation(async input => {
    const slow = String(input).endsWith('/watch');
    await new Promise(resolve => setTimeout(resolve, slow ? ROUTE_FIRST_RESPONSE_TIMEOUT_MS + 1_000 : 100));
    return Response.json({});
  });
  const started = Date.now();
  const pending = run(env(), operation);
  await vi.advanceTimersByTimeAsync(ROUTE_FIRST_RESPONSE_TIMEOUT_MS + 1_100);
  await expect(pending).resolves.toBe(transcript);
  expect(proxyTransport).toHaveBeenCalledTimes(1);
  expect(Date.now() - started).toBeLessThan(ROUTE_FIRST_RESPONSE_TIMEOUT_MS + 1_200);
});

test('concurrent requests on a silent route share one deadline and fail together', async () => {
  vi.useFakeTimers();
  let calls = 0;
  const execute = vi.fn<WorkerExtractionDependencies['execute']>(async (_op, fetchImpl) => {
    await Promise.all([fetchImpl('https://www.youtube.com/a'), fetchImpl('https://www.youtube.com/b')]);
    return transcript;
  });
  const { run, proxyFetch, proxyTransport } = harness(execute);
  proxyFetch.mockImplementation(async () => { calls++; return calls <= 2 ? new Promise<Response>(() => {}) : Response.json({}); });
  const pending = run(env(), operation);
  await vi.advanceTimersByTimeAsync(ROUTE_FIRST_RESPONSE_TIMEOUT_MS + 50);
  await expect(pending).resolves.toBe(transcript);
  expect(proxyTransport).toHaveBeenCalledTimes(2);
});
