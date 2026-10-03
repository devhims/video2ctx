import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { runYouTubeOperation, YouTubeProcessorError } from '../src/lib/youtube-processor-client';
import * as worker from '../src/lib/youtube-worker-extraction';
import type { ExtractionAttempt } from '../src/lib/extraction-diagnostics';

const operation = { kind: 'transcript', id: 'abcdefghijk', granularity: 'word' } as const;
const failed = () => new YouTubeProcessorError('UNAVAILABLE', 'YouTube challenged this route.', 503, true);

function setup(backend: 'worker' | 'container' = 'worker', recovered = true) {
  const execute = vi.fn<worker.WorkerExtractionDependencies['execute']>(async () => { throw failed(); });
  const proxyTransport = vi.fn(() => ({ fetch: vi.fn<typeof fetch>(), close: async () => {} }));
  const workerRun = vi.spyOn(worker, 'runWorkerYouTubeOperation').mockImplementation(worker.createWorkerExtractionRunner({ execute, proxyTransport }));
  const requests: Request[] = [];
  const containerFetch = vi.fn(async (request: Request) => {
    requests.push(request);
    const direct = request.headers.get('x-processor-egress') === 'direct';
    return Response.json(direct && recovered ? { value: { text: 'Recovered', sheets: [] } }
      : { error: { code: 'UNAVAILABLE', message: 'Challenged', retryable: true } }, {
      status: direct && recovered ? 200 : 503,
      headers: { 'x-processor-egress': direct ? 'direct' : 'proxy' },
    });
  });
  const env = {
    YOUTUBE_EXTRACTION_BACKEND: backend, YOUTUBE_EXTRACTION_TIMEOUT_MS: '120000',
    YOUTUBE_PROCESSOR_TIMEOUT_MS: '120000', YOUTUBE_PROCESSOR_INSTANCE_COUNT: '2',
    YOUTUBE_PROCESSOR_MAX_ATTEMPTS: '4', YOUTUBE_EXTRACTION_RETRY_BASE_MS: '0', YOUTUBE_PROCESSOR_RETRY_BASE_MS: '0',
    OUTBOUND_PROXY_URLS: JSON.stringify([0, 1, 2, 3].map(slot => `http://proxy-${slot}.example:8080`)),
    YOUTUBE_PROCESSOR: { idFromName: (name: string) => name, get: () => ({ fetch: containerFetch }) },
  } as unknown as Env;
  const diagnostics: ExtractionAttempt[] = [];
  return { env, requests, containerFetch, execute, workerRun, diagnostics, record: (event: ExtractionAttempt) => diagnostics.push(event) };
}

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

test.each(['worker', 'container'] as const)('%s proxy failures get exactly one direct container attempt', async backend => {
  const { env, requests, execute, diagnostics, record } = setup(backend);
  await expect(runYouTubeOperation(env, operation, record)).resolves.toMatchObject({ text: 'Recovered' });
  expect(execute).toHaveBeenCalledTimes(backend === 'worker' ? 4 : 0);
  expect(requests.filter(request => request.headers.get('x-processor-egress') === 'direct')).toHaveLength(1);
  expect(requests).toHaveLength(backend === 'worker' ? 1 : 5);
  expect(diagnostics).toHaveLength(5);
  expect(diagnostics.at(-1)).toMatchObject({ attempt: 5, backend: 'container', egress: 'direct', outcome: 'success', extractionId: diagnostics[0]!.extractionId });
});

test('storyboard extraction uses the same final direct route', async () => {
  const { env, requests, record, workerRun } = setup();
  await expect(runYouTubeOperation(env, { kind: 'storyboard', id: operation.id }, record)).resolves.toMatchObject({ sheets: [] });
  expect(workerRun).not.toHaveBeenCalled();
  expect(requests).toHaveLength(5);
  expect(requests.at(-1)!.headers.get('x-processor-egress')).toBe('direct');
});

test('returns clear unavailability only after the final direct attempt fails', async () => {
  const { env, containerFetch, diagnostics, record } = setup('worker', false);
  await expect(runYouTubeOperation(env, operation, record)).rejects.toMatchObject({ code: 'UNAVAILABLE', message: 'YouTube is not available right now.' });
  expect(containerFetch).toHaveBeenCalledTimes(1);
  expect(diagnostics.at(-1)).toMatchObject({ attempt: 5, egress: 'direct', outcome: 'failed' });
});

test.each(['INVALID_INPUT', 'AUTH_REQUIRED', 'CAPTIONS_UNAVAILABLE', 'REGION_RESTRICTED', 'NOT_FOUND'] as const)('does not use direct fallback for %s', async code => {
  const { env, execute, containerFetch } = setup();
  execute.mockRejectedValue(new YouTubeProcessorError(code, 'Specific restriction', 404));
  await expect(runYouTubeOperation(env, operation)).rejects.toMatchObject({ code });
  expect(containerFetch).not.toHaveBeenCalled();
});

test.each(['', '{invalid'])('does not bypass missing or invalid proxy configuration', async pool => {
  const { env, containerFetch } = setup();
  env.OUTBOUND_PROXY_URLS = pool;
  await expect(runYouTubeOperation(env, operation)).rejects.toMatchObject({ code: 'PROCESSOR_UNAVAILABLE' });
  expect(containerFetch).not.toHaveBeenCalled();
});

test('successful proxy extraction never invokes the direct container', async () => {
  const { env, execute, containerFetch } = setup();
  execute.mockResolvedValue({ text: 'Cached route result' } as never);
  await expect(runYouTubeOperation(env, operation)).resolves.toMatchObject({ text: 'Cached route result' });
  expect(containerFetch).not.toHaveBeenCalled();
});

test('an old container image cannot silently count a proxied response as direct recovery', async () => {
  const { env, containerFetch } = setup();
  containerFetch.mockResolvedValue(Response.json({ value: { text: 'Still proxied' } }));
  await expect(runYouTubeOperation(env, operation)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  expect(containerFetch).toHaveBeenCalledTimes(1);
});

test('the direct deadline cancels response-body reads as well as container startup', async () => {
  vi.useFakeTimers();
  const { env, containerFetch, record, diagnostics } = setup();
  const canceled = vi.fn();
  containerFetch.mockResolvedValue(new Response(new ReadableStream({ cancel: canceled }), { headers: { 'x-processor-egress': 'direct' } }));
  const rejected = expect(runYouTubeOperation(env, operation, record)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  await vi.waitFor(() => expect(containerFetch).toHaveBeenCalledTimes(1));
  await vi.advanceTimersByTimeAsync(5_001);
  await rejected;
  expect(containerFetch).toHaveBeenCalledTimes(1);
  expect(canceled).toHaveBeenCalled();
  expect(diagnostics.at(-1)).toMatchObject({ egress: 'direct', failureKind: 'timeout' });
});

test('reserves fallback time inside the original operation deadline and cancels a stalled direct request', async () => {
  vi.useFakeTimers();
  const { env, execute, containerFetch, diagnostics, record } = setup();
  Object.assign(env, { YOUTUBE_EXTRACTION_TIMEOUT_MS: '1000' });
  execute.mockImplementation(() => new Promise(() => {}));
  let directSignal: AbortSignal | undefined;
  containerFetch.mockImplementation(async request => { directSignal = request.signal; return new Promise(() => {}); });
  const pending = runYouTubeOperation(env, operation, record);
  const rejected = expect(pending).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  await vi.advanceTimersByTimeAsync(499);
  expect(containerFetch).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(2);
  expect(containerFetch).toHaveBeenCalledTimes(1);
  expect(directSignal!.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(500);
  await rejected;
  expect(directSignal!.aborted).toBe(true);
  expect(diagnostics.at(-1)).toMatchObject({ egress: 'direct', failureKind: 'timeout' });
});
