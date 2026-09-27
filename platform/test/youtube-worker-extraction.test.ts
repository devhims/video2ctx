import { createWorkerExtractionRunner, workerProxyUrls, type WorkerExtractionDependencies } from '../src/lib/youtube-worker-extraction';
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
  const directFetch = vi.fn<typeof fetch>(async () => Response.json({}));
  const close = vi.fn(async () => {});
  const proxyFetch = vi.fn<typeof fetch>(async () => Response.json({}));
  const proxyTransport = vi.fn((_url: string) => ({ fetch: proxyFetch, close }));
  const run = createWorkerExtractionRunner({ execute, directFetch, proxyTransport });
  return { run, directFetch, proxyFetch, proxyTransport, close };
}

beforeEach(() => { vi.spyOn(console, 'info').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

test('direct success never creates a proxy and returns the same result with safe diagnostics', async () => {
  const execute = vi.fn(async () => transcript);
  const { run, proxyTransport } = harness(execute);
  const diagnostic = vi.fn();
  expect(await run(env(), operation, diagnostic)).toBe(transcript);
  expect(proxyTransport).not.toHaveBeenCalled();
  expect(diagnostic).toHaveBeenCalledWith(expect.objectContaining({ backend: 'worker', egress: 'direct', attempt: 1, outcome: 'success' }));
});

test('whole-operation fallback visits each proxy before repeating, including a fifth attempt', async () => {
  const execute = vi.fn<WorkerExtractionDependencies['execute']>().mockRejectedValueOnce(unavailable()).mockRejectedValueOnce(unavailable()).mockRejectedValueOnce(unavailable()).mockRejectedValueOnce(unavailable()).mockResolvedValue(transcript);
  const { run, proxyTransport, close } = harness(execute);
  const diagnostics: ExtractionAttempt[] = [];
  await expect(run(env(), operation, event => diagnostics.push(event))).resolves.toBe(transcript);
  expect(execute).toHaveBeenCalledTimes(5);
  for (const [op] of execute.mock.calls) expect(op).toBe(operation);
  const urls = proxyTransport.mock.calls.map(call => call[0]);
  expect(urls[0]).not.toEqual(urls[1]);
  expect(urls[2]).toEqual(urls[0]); expect(urls[3]).toEqual(urls[1]);
  expect(close).toHaveBeenCalledTimes(4);
  expect(diagnostics).toHaveLength(5);
  expect(diagnostics.at(-1)).toMatchObject({ attempt: 5, outcome: 'success', egress: 'proxy' });
});

test.each(['INVALID_INPUT', 'AUTH_REQUIRED'] as const)('%s is terminal even when marked retryable', async code => {
  const { run, proxyTransport } = harness(async () => { throw new YouTubeProcessorError(code, 'private secret', 400, true); });
  await expect(run(env(), operation)).rejects.toMatchObject({ code });
  expect(proxyTransport).not.toHaveBeenCalled();
});

test('no configured proxy means exactly one attempt', async () => {
  const execute = vi.fn(async () => { throw unavailable(); });
  const { run } = harness(execute);
  await expect(run(env({ OUTBOUND_PROXY_URLS: '' }), operation)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  expect(execute).toHaveBeenCalledTimes(1);
});

test('an earlier upstream error is not overwritten by a later transcript NOT_FOUND', async () => {
  const execute = vi.fn<WorkerExtractionDependencies['execute']>()
    .mockRejectedValueOnce(new YouTubeProcessorError('RATE_LIMITED', 'rate limit', 429, true))
    .mockRejectedValue(new YouTubeProcessorError('NOT_FOUND', 'missing', 404));
  const { run } = harness(execute);
  await expect(run(env(), operation)).rejects.toMatchObject({ code: 'RATE_LIMITED', status: 429 });
});

test('partial track catalogs visit each distinct route only once', async () => {
  const partial = { tracks: [], meta: { partial: true } } as unknown as CaptionTrackList;
  const execute = vi.fn(async () => partial);
  const { run } = harness(execute);
  await expect(run(env(), { kind: 'caption-tracks', id: operation.id })).resolves.toBe(partial);
  expect(execute).toHaveBeenCalledTimes(3);
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
  expect(restrictedHarness.proxyTransport).not.toHaveBeenCalled();
});

test('timeouts cover body reads and use a fresh proxy attempt', async () => {
  vi.useFakeTimers();
  const execute = vi.fn<WorkerExtractionDependencies['execute']>(async (_op, fetchImpl) => {
    await fetchImpl('https://www.youtube.com/api/timedtext'); return transcript;
  });
  const { run, directFetch, proxyTransport } = harness(execute);
  directFetch.mockImplementationOnce(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])); } })));
  const result = run(env({ YOUTUBE_DIRECT_TIMEOUT_MS: '100' }), operation);
  await vi.advanceTimersByTimeAsync(105);
  await expect(result).resolves.toBe(transcript);
  expect(proxyTransport).toHaveBeenCalledTimes(1);
});

test('ignoring fetch cancellation cannot hold the direct attempt forever', async () => {
  vi.useFakeTimers();
  const execute = vi.fn<WorkerExtractionDependencies['execute']>(async (_op, fetchImpl) => { await fetchImpl('https://www.youtube.com/api/timedtext'); return transcript; });
  const { run, directFetch } = harness(execute);
  directFetch.mockImplementationOnce(() => new Promise(() => {}));
  const pending = run(env({ YOUTUBE_DIRECT_TIMEOUT_MS: '100' }), operation);
  await vi.advanceTimersByTimeAsync(105);
  await expect(pending).resolves.toBe(transcript);
});

test('Retry-After waits are bounded by the total operation deadline', async () => {
  vi.useFakeTimers();
  const execute = vi.fn<WorkerExtractionDependencies['execute']>(async (_op, fetchImpl) => { await fetchImpl('https://www.youtube.com/watch'); throw unavailable(); });
  const { run, directFetch, proxyTransport } = harness(execute);
  directFetch.mockResolvedValue(new Response('', { status: 429, headers: { 'retry-after': '60' } }));
  const pending = run(env({ YOUTUBE_EXTRACTION_TIMEOUT_MS: '1000' }), operation);
  const rejected = expect(pending).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  await vi.advanceTimersByTimeAsync(1001);
  await rejected;
  expect(proxyTransport).not.toHaveBeenCalled();
});

test('canceling an operation prevents later routes', async () => {
  const controller = new AbortController();
  const { run, proxyTransport } = harness(async () => { controller.abort(); throw unavailable(); });
  await expect(run(env(), operation, undefined, controller.signal)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  expect(proxyTransport).not.toHaveBeenCalled();
});

test('oversized upstream bodies fail before reaching the parser', async () => {
  const { run, directFetch } = harness(async (_op, fetchImpl) => { await fetchImpl('https://www.youtube.com/watch'); return transcript; });
  directFetch.mockImplementation(async () => new Response(new Uint8Array(8 * 1024 * 1024 + 1)));
  await expect(run(env({ OUTBOUND_PROXY_URLS: '' }), operation)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
});

test('raw transport errors cannot disclose URLs, credentials or nested causes', async () => {
  const { run } = harness(async () => { throw new Error('http://user:secret@proxy-a.example signed?token=secret', { cause: new Error('secret') }); });
  const sink = vi.fn();
  try { await run(env({ OUTBOUND_PROXY_URLS: '' }), operation, sink); throw new Error('expected failure'); }
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

test('actual library keeps source metadata and caption download on the same fallback transport', async () => {
  const captionRequests: string[] = [];
  const directFetch: typeof fetch = async () => new Response('', { status: 429 });
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
  const run = createWorkerExtractionRunner({ execute: executeWorkerYouTubeOperation, directFetch, proxyTransport: () => ({ fetch: proxyFetch, close }) });
  await expect(run(env(), operation)).resolves.toMatchObject({ text: 'Bonjour', translatedTo: { languageCode: 'fr' } });
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
  const execute = vi.fn<WorkerExtractionDependencies['execute']>().mockRejectedValueOnce(unavailable()).mockResolvedValue(transcript);
  const { run, close } = harness(execute);
  close.mockImplementation(() => new Promise(() => {}));
  const pending = run(env(), operation);
  await vi.advanceTimersByTimeAsync(1001);
  await expect(pending).resolves.toBe(transcript);
});
