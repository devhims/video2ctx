import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { runYouTubeOperation, YouTubeProcessorError } from '../src/lib/youtube-processor-client';
import * as worker from '../src/lib/youtube-worker-extraction';
import { YouTubeCacheCoordinatorCore } from '../src/lib/youtube-cache-coordinator';
import { getTranscriptWithCache } from '../src/lib/youtube';
import { executeGetVideoTranscript } from '../src/agents/providers/youtube/tools/get-video-transcript';
import { executeGetVideoStoryboard } from '../src/agents/providers/youtube/tools/get-video-storyboard';
import { createYouTubeAgentProvider } from '../src/agents/providers/youtube/provider';
import type { AgentToolContext } from '../src/agents/providers/youtube/tool-context';
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

test('preserves the proxy failure after the final direct attempt fails', async () => {
  const { env, containerFetch, diagnostics, record } = setup('worker', false);
  await expect(runYouTubeOperation(env, operation, record)).rejects.toMatchObject({ code: 'UNAVAILABLE', message: 'YouTube is temporarily unavailable.', retryable: true });
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
  await vi.advanceTimersByTimeAsync(120_001);
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

test.each(['RATE_LIMITED', 'UPSTREAM_ERROR', 'UNAVAILABLE'] as const)('preserves the exact original %s error when direct fallback fails', async code => {
  const { env, workerRun, containerFetch } = setup();
  const original = Object.assign(new YouTubeProcessorError(code, 'Original proxy failure', 429, true, 3000), { reason: 'bot_challenge' });
  workerRun.mockRejectedValue(original);
  containerFetch.mockRejectedValue(new Error('Container startup failed'));
  await expect(runYouTubeOperation(env, operation)).rejects.toBe(original);
  expect(console.info).toHaveBeenCalledWith(expect.stringContaining('youtube_direct_fallback'));
});

test.each(['old-image', 'invalid-input'])('%s direct failures preserve the original infrastructure error', async failure => {
  const { env, workerRun, containerFetch } = setup();
  const original = new Error('Proxy adapter failure');
  workerRun.mockRejectedValue(original);
  containerFetch.mockResolvedValue(failure === 'old-image' ? Response.json({ value: { text: 'Still proxied' } })
    : Response.json({ error: { code: 'INVALID_INPUT', message: 'Invalid internal direct request' } }, {
      status: 422, headers: { 'x-processor-egress': 'direct' },
    }));
  await expect(runYouTubeOperation(env, operation)).rejects.toBe(original);
  expect(console.info).toHaveBeenCalledWith(expect.stringContaining(failure === 'old-image' ? 'INVALID_PROCESSOR_RESPONSE' : 'INVALID_INPUT'));
});

test.each(['worker', 'container'] as const)('the off switch skips direct fallback for %s', async backend => {
  const { env, requests, execute } = setup(backend, false);
  Object.assign(env, { YOUTUBE_DIRECT_FALLBACK: 'off' });
  await expect(runYouTubeOperation(env, operation)).rejects.toMatchObject({ code: 'UNAVAILABLE', retryable: true });
  expect(requests.filter(request => request.headers.get('x-processor-egress') === 'direct')).toHaveLength(0);
  expect(execute).toHaveBeenCalledTimes(backend === 'worker' ? 4 : 0);
  expect(requests).toHaveLength(backend === 'worker' ? 0 : 4);
});

test('the off switch preserves time that would otherwise be reserved for fallback', async () => {
  vi.useFakeTimers();
  const { env, execute, containerFetch } = setup();
  Object.assign(env, { YOUTUBE_DIRECT_FALLBACK: 'off', YOUTUBE_EXTRACTION_TIMEOUT_MS: '1000' });
  execute.mockImplementation(async () => {
    await new Promise(resolve => setTimeout(resolve, 800));
    return { text: 'Proxy recovered within its original budget' } as never;
  });
  const pending = runYouTubeOperation(env, operation);
  const result = expect(pending).resolves.toMatchObject({ text: 'Proxy recovered within its original budget' });
  await vi.advanceTimersByTimeAsync(801);
  await result;
  expect(execute).toHaveBeenCalledTimes(1);
  expect(containerFetch).not.toHaveBeenCalled();
});

test.each(['AUTH_REQUIRED', 'CAPTIONS_UNAVAILABLE', 'REGION_RESTRICTED', 'NOT_FOUND'] as const)('preserves a confirmed %s restriction from the direct route', async code => {
  const { env, containerFetch } = setup();
  containerFetch.mockResolvedValue(Response.json({ error: { code, message: 'Content restriction', retryable: false } }, {
    status: 404, headers: { 'x-processor-egress': 'direct' },
  }));
  await expect(runYouTubeOperation(env, operation)).rejects.toMatchObject({ code, retryable: false });
});

test.each(['worker', 'container'] as const)('retains bot classification through %s proxies, direct fallback, cache wire, and agent tool', async backend => {
  const { env, execute, containerFetch, diagnostics, record } = setup(backend, false);
  execute.mockRejectedValue(Object.assign(new Error('SECRET upstream response'), { code: 'UNAVAILABLE', reason: 'bot_challenge' }));
  containerFetch.mockImplementation(async request => Response.json({ error: {
    code: request.headers.get('x-processor-egress') === 'direct' ? 'UPSTREAM_ERROR' : 'UNAVAILABLE',
    message: 'YouTube challenged this route.', reason: 'bot_challenge', retryable: true,
  } }, { status: 503, headers: { 'x-processor-egress': request.headers.get('x-processor-egress') ?? 'proxy' } }));
  const coordinator = new YouTubeCacheCoordinatorCore(env, (bindings, input, onDiagnostic) =>
    runYouTubeOperation(bindings, input as typeof operation, onDiagnostic));
  Object.assign(env, {
    YOUTUBE_CACHE: { get: vi.fn(async () => null), put: vi.fn() },
    YOUTUBE_REQUEST_COORDINATOR: { getByName: () => ({ getOrLoad: async (json: string) =>
      JSON.stringify(await coordinator.getOrLoad(JSON.parse(json))) }) },
  });
  const context: AgentToolContext = {
    runId: 'fallback-chain', signal: new AbortController().signal,
    transcriptPolicy: { mode: 'complete_transcript' }, finalize: vi.fn(),
    provider: { transcript: (id: string, language?: string) => getTranscriptWithCache(env, id, language, record) } as AgentToolContext['provider'],
    executeEvidenceTool: execution => execution.execute(),
  };
  await expect(executeGetVideoTranscript({ videoId: operation.id }, context, 'transcript')).rejects.toMatchObject({
    code: 'YOUTUBE_UNAVAILABLE', message: expect.stringContaining('[upstream=UNAVAILABLE; reason=bot_challenge]'),
    cause: expect.objectContaining({ code: 'UNAVAILABLE', reason: 'bot_challenge' }),
  });
  expect(diagnostics).toHaveLength(5);
  expect(diagnostics.at(-1)).toMatchObject({ egress: 'direct', outcome: 'failed' });
});

test.each(['worker', 'container'] as const)('direct %s recovery may take over five seconds and uses the caller deadline', async backend => {
  vi.useFakeTimers();
  const { env, containerFetch } = setup(backend);
  const original = containerFetch.getMockImplementation()!;
  const deadlineAt = Date.now() + 180_000;
  let directSignal: AbortSignal | undefined;
  containerFetch.mockImplementation(async request => {
    if (request.headers.get('x-processor-egress') === 'direct') {
      expect(Number(request.headers.get('x-extraction-deadline-at'))).toBe(deadlineAt);
      directSignal = request.signal;
      await new Promise(resolve => setTimeout(resolve, 6000));
    }
    return original(request);
  });
  const result = expect(runYouTubeOperation(env, { ...operation, deadlineAt })).resolves.toMatchObject({ text: 'Recovered' });
  await vi.waitFor(() => expect(directSignal).toBeDefined());
  await vi.advanceTimersByTimeAsync(6001);
  await result;
  expect(directSignal?.aborted).toBe(false);
});

test('a research deadline shorter than the configured timeout cancels direct recovery', async () => {
  vi.useFakeTimers();
  const { env, containerFetch } = setup();
  containerFetch.mockImplementation(async () => new Promise(() => {}));
  const rejected = expect(runYouTubeOperation(env, { ...operation, deadlineAt: Date.now() + 6000 }))
    .rejects.toMatchObject({ code: 'UNAVAILABLE' });
  await vi.advanceTimersByTimeAsync(6001);
  await rejected;
});

test.each(['transcript', 'storyboard'] as const)('agent %s forwards its research deadline to direct recovery', async kind => {
  const { env, requests } = setup('worker', false);
  const deadlineAt = Date.now() + 180_000;
  const coordinator = new YouTubeCacheCoordinatorCore(env, (bindings, input, diagnostic) =>
    runYouTubeOperation(bindings, input as typeof operation, diagnostic));
  Object.assign(env, {
    YOUTUBE_CACHE: { get: vi.fn(async () => null), put: vi.fn() },
    YOUTUBE_REQUEST_COORDINATOR: { getByName: () => ({ getOrLoad: async (json: string) =>
      JSON.stringify(await coordinator.getOrLoad(JSON.parse(json))) }) },
  });
  const provider = createYouTubeAgentProvider(env, undefined, deadlineAt);
  await expect(kind === 'transcript' ? provider.transcript(operation.id) : provider.storyboard!(operation.id))
    .rejects.toMatchObject({ code: 'UNAVAILABLE' });
  expect(Number(requests.at(-1)!.headers.get('x-extraction-deadline-at'))).toBe(deadlineAt);
});

test('storyboard tool sends its retrieval deadline to direct recovery and preserves analysis time', async () => {
  vi.useFakeTimers();
  const { env, containerFetch, requests } = setup();
  const normalFetch = containerFetch.getMockImplementation()!;
  const researchDeadlineAt = Date.now() + 80_000;
  let directRequest: Request | undefined;
  containerFetch.mockImplementation(async request => {
    if (request.headers.get('x-processor-egress') !== 'direct') return normalFetch(request);
    directRequest = request;
    return new Promise(() => {});
  });
  const context = {
    runId: 'storyboard-budget', researchDeadlineAt, signal: new AbortController().signal,
    provider: createYouTubeAgentProvider(env, undefined, researchDeadlineAt),
    executeEvidenceTool: execution => execution.execute(),
  } as AgentToolContext;
  const rejected = expect(executeGetVideoStoryboard({ videoId: operation.id }, context, 'storyboard'))
    .rejects.toThrow('Storyboard retrieval exceeded its budget');
  await vi.waitFor(() => expect(directRequest).toBeDefined());
  const retrievalDeadline = Number(directRequest!.headers.get('x-extraction-deadline-at'));
  expect(retrievalDeadline).toBe(researchDeadlineAt - 35_000);
  await vi.advanceTimersByTimeAsync(retrievalDeadline - Date.now());
  await rejected;
  expect(directRequest!.signal.aborted).toBe(true);
  expect(researchDeadlineAt - Date.now()).toBe(35_000);
  expect(requests).toHaveLength(4);
});
