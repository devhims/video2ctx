import { executeWorkerYouTubeOperation, type WorkerYouTubeOperation, type WorkerYouTubeResult } from './youtube-worker-runtime';
import { createWorkerProxyTransport, type YouTubeFetchTransport } from './youtube-worker-transport';
import { YouTubeProcessorError, shouldFallbackError, shouldFallbackResult, randomProcessorSlot, processorSlotOrder, type YouTubeOperationResult } from './youtube-processor-client';
import { emitExtractionDiagnostic, extractionFailureKind, type ExtractionAttempt, type ExtractionDiagnosticSink } from './extraction-diagnostics';
import { isVideoMetadataBotChallenge } from './youtube-metadata';

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_ATTEMPT_BYTES = 32 * 1024 * 1024;
/** Time a proxy route gets to return its first response before the operation moves to the next proxy. */
export const ROUTE_FIRST_RESPONSE_TIMEOUT_MS = 5_000;
const SAFE_CODES = ['INVALID_INPUT', 'INVALID_RESPONSE', 'NOT_FOUND', 'CAPTIONS_UNAVAILABLE', 'REGION_RESTRICTED', 'UNAVAILABLE', 'UPSTREAM_ERROR', 'RATE_LIMITED', 'AUTH_REQUIRED'] as const;
type SafeCode = typeof SAFE_CODES[number];

function bounded(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return value !== undefined && value.trim() && Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.floor(parsed))) : fallback;
}

export function workerProxyUrls(env: Pick<Env, 'OUTBOUND_PROXY_URLS' | 'OUTBOUND_PROXY_URL'>): string[] {
  const pool = env.OUTBOUND_PROXY_URLS?.trim();
  const single = env.OUTBOUND_PROXY_URL?.trim();
  try {
    const values: unknown = pool ? JSON.parse(pool) : single ? [single] : [];
    if (!Array.isArray(values) || values.length > 4 || (pool && !values.length)) throw new Error();
    const urls = values.map((value: unknown) => {
      if (typeof value !== 'string' || !value.trim()) throw new Error();
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.hash) throw new Error();
      return url.href;
    });
    if (new Set(urls).size !== urls.length) throw new Error();
    return urls;
  } catch {
    // URL and JSON parse errors can echo credentials. Never forward their text.
    throw new YouTubeProcessorError('PROCESSOR_UNAVAILABLE', 'The YouTube proxy configuration is invalid.', 503);
  }
}

function safeFailure(error: unknown, signal: AbortSignal): YouTubeProcessorError {
  if (signal.aborted) return new YouTubeProcessorError('UNAVAILABLE', 'YouTube extraction exceeded its time limit or was canceled.', 503, true);
  const value = error as { code?: unknown; status?: unknown; retryable?: unknown } | null;
  const code = SAFE_CODES.find(code => code === value?.code);
  if (!code) return new YouTubeProcessorError('UPSTREAM_ERROR', 'The YouTube connection failed.', 503, true);
  const messages: Record<SafeCode, string> = {
    INVALID_INPUT: 'The YouTube request is invalid.', INVALID_RESPONSE: 'YouTube returned an unusable response.',
    NOT_FOUND: 'The requested YouTube resource was not found.', UNAVAILABLE: 'YouTube is temporarily unavailable.',
    REGION_RESTRICTED: 'The uploader has not made this video available in the current request region.',
    CAPTIONS_UNAVAILABLE: 'Captions are not available for this video.',
    UPSTREAM_ERROR: 'The YouTube request failed.', RATE_LIMITED: 'YouTube rate limited the request.',
    AUTH_REQUIRED: 'YouTube requires authorization for this resource.',
  };
  const status = typeof value?.status === 'number' && Number.isInteger(value.status) && value.status >= 100 && value.status <= 599 ? value.status : undefined;
  return new YouTubeProcessorError(code, messages[code], status, !['INVALID_INPUT', 'AUTH_REQUIRED', 'CAPTIONS_UNAVAILABLE', 'REGION_RESTRICTED'].includes(code) && (value?.retryable === true || ['RATE_LIMITED', 'UPSTREAM_ERROR', 'INVALID_RESPONSE', 'UNAVAILABLE'].includes(code)));
}

/** Stop waiting even if an underlying adapter does not implement cancellation. */
async function abortable<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let cancel!: () => void;
  const aborted = new Promise<never>((_, reject) => { cancel = () => reject(signal.reason); signal.addEventListener('abort', cancel, { once: true }); });
  try { return await Promise.race([work(), aborted]); }
  finally { signal.removeEventListener('abort', cancel); }
}

async function wait(ms: number, signal: AbortSignal): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await abortable(signal, () => new Promise<void>(resolve => { timer = setTimeout(resolve, ms); })); }
  finally { clearTimeout(timer); }
}

async function boundedBody(response: Response, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await abortable(signal, () => reader.read());
      signal.throwIfAborted();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) throw new YouTubeProcessorError('INVALID_RESPONSE', 'YouTube response exceeded the byte limit.', 502, true);
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

export interface WorkerExtractionDependencies {
  execute: (operation: WorkerYouTubeOperation, fetchImpl: typeof fetch) => Promise<WorkerYouTubeResult>;
  proxyTransport: (url: string) => YouTubeFetchTransport;
}

/** Bounded whole-operation retries across the required proxy pool. */
export function createWorkerExtractionRunner(deps: WorkerExtractionDependencies) {
  return async function run<T extends WorkerYouTubeOperation>(env: Env, operation: T, onDiagnostic?: ExtractionDiagnosticSink, signal?: AbortSignal): Promise<YouTubeOperationResult<T>> {
    const urls = workerProxyUrls(env);
    if (!urls.length) throw new YouTubeProcessorError('PROCESSOR_UNAVAILABLE', 'A YouTube proxy must be configured for Worker extraction.', 503);
    const order = processorSlotOrder(urls.length, randomProcessorSlot(urls.length));
    const proxyAttempts = bounded(env.YOUTUBE_PROXY_MAX_ATTEMPTS, 4, 1, 4);
    const routes: Array<{ egress: 'proxy'; slot: number; url: string }> = [];
    for (let i = 0; i < proxyAttempts; i++) { const slot = order[i % order.length]!; routes.push({ egress: 'proxy', slot, url: urls[slot]! }); }
    const total = new AbortController();
    const totalTimer = setTimeout(() => total.abort(new DOMException('Extraction deadline', 'TimeoutError')), bounded(env.YOUTUBE_EXTRACTION_TIMEOUT_MS, 120_000, 1_000, 300_000));
    const deadline = signal ? AbortSignal.any([signal, total.signal]) : total.signal;
    const extractionId = crypto.randomUUID();
    let lastFailure: YouTubeProcessorError | undefined;
    let upstreamFailure: YouTubeProcessorError | undefined;
    try {
      for (const [index, route] of routes.entries()) {
        deadline.throwIfAborted();
        const attempt = new AbortController();
        const timeout = bounded(env.YOUTUBE_PROXY_TIMEOUT_MS, 25_000, 100, 60_000);
        const timer = setTimeout(() => attempt.abort(new DOMException('Attempt deadline', 'TimeoutError')), timeout);
        const attemptSignal = AbortSignal.any([deadline, attempt.signal]);
        const started = Date.now();
        let transport: YouTubeFetchTransport | undefined;
        let bytesRead = 0;
        let retryAfter = 0;
        let outcome: ExtractionAttempt['outcome'] = 'failed';
        let failureKind: ExtractionAttempt['failureKind'];
        let status: number | undefined;
        let retry = false;
        // Until this route answers once, a stalled request means a bad exit, not a slow upstream.
        // The last route keeps only the attempt timeout, because failing it early leaves no alternative.
        const firstResponseMs = index + 1 < routes.length ? ROUTE_FIRST_RESPONSE_TIMEOUT_MS : undefined;
        let routeAnswered = false;
        let routeStalled: YouTubeProcessorError | undefined;
        // One timer per route, started by its first request. Any response clears it, so a slower
        // concurrent request on a route that has already answered is never cut short.
        let routeGuard: AbortController | undefined;
        let routeGuardTimer: ReturnType<typeof setTimeout> | undefined;
        const events: ExtractionAttempt['events'] = [];
        let droppedEvents = 0;
        const record = (event: ExtractionAttempt['events'][number]) => { if (events.length < 64) events.push(event); else droppedEvents++; };
        try {
          transport = deps.proxyTransport(route.url);
          const fetchImpl = transport.fetch;
          const trackedFetch: typeof fetch = async (input, init = {}) => {
            if (routeStalled) throw routeStalled;
            const requestSignal = init.signal ?? (input instanceof Request ? input.signal : undefined);
            const activeSignal = requestSignal ? AbortSignal.any([attemptSignal, requestSignal]) : attemptSignal;
            activeSignal.throwIfAborted();
            if (!routeAnswered && firstResponseMs !== undefined && !routeGuard) {
              const guard = new AbortController();
              routeGuard = guard;
              routeGuardTimer = setTimeout(() => guard.abort(new DOMException('Route first response', 'TimeoutError')), firstResponseMs);
            }
            const guard = routeAnswered ? undefined : routeGuard;
            const fetchSignal = guard ? AbortSignal.any([activeSignal, guard.signal]) : activeSignal;
            let response: Response;
            try {
              response = await abortable(fetchSignal, () => fetchImpl(input, { ...init, signal: fetchSignal }));
            } catch (error) {
              if (guard?.signal.aborted && !activeSignal.aborted) {
                // Latch the route so library retries on it fail at once instead of stalling again.
                routeStalled ??= new YouTubeProcessorError('UPSTREAM_ERROR', 'The YouTube proxy route did not respond.', 503, true);
                throw routeStalled;
              }
              throw error;
            }
            routeAnswered = true;
            clearTimeout(routeGuardTimer);
            if (response.status === 429 || response.status >= 500) {
              const raw = response.headers.get('retry-after');
              const seconds = raw === null ? NaN : Number(raw);
              const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(raw ?? '') - Date.now();
              if (Number.isFinite(delay)) retryAfter = Math.max(retryAfter, delay, 0);
            }
            const bytes = await boundedBody(response, activeSignal);
            bytesRead += bytes.length;
            if (bytesRead > MAX_ATTEMPT_BYTES) throw new YouTubeProcessorError('INVALID_RESPONSE', 'YouTube extraction exceeded the byte budget.', 502, true);
            const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
            record({ stage: path === '/watch' || path.endsWith('/player') ? 'caption_metadata' : 'download', outcome: response.ok ? 'success' : 'error', status: response.status, elapsedMs: Date.now() - started });
            const headers = new Headers(response.headers);
            headers.delete('content-length'); headers.delete('content-encoding');
            return new Response([204, 205, 304].includes(response.status) ? null : bytes, { status: response.status, statusText: response.statusText, headers });
          };
          const value = await abortable(attemptSignal, () => deps.execute(operation, trackedFetch));
          attemptSignal.throwIfAborted();
          if (operation.kind === 'video' && isVideoMetadataBotChallenge(value)) throw new YouTubeProcessorError('UNAVAILABLE', 'YouTube blocked this connection.', 503, true);
          // Partial catalogs probe every distinct route once, without repeated pool passes.
          if (shouldFallbackResult(operation, value) && index + 1 < Math.min(routes.length, urls.length)) {
            outcome = 'fallback'; retry = true;
          } else {
            outcome = 'success'; status = 200;
            record({ stage: 'complete', outcome: 'success', elapsedMs: Date.now() - started });
            return value as YouTubeOperationResult<T>;
          }
        } catch (error) {
          const failure = routeStalled ?? safeFailure(error, attemptSignal);
          lastFailure = failure;
          if (!['NOT_FOUND', 'INVALID_INPUT'].includes(failure.code)) upstreamFailure = failure;
          status = failure.status;
          failureKind = routeStalled ? 'timeout' : extractionFailureKind(error, attemptSignal);
          retry = !deadline.aborted && index + 1 < routes.length && shouldFallbackError(operation, failure);
          outcome = retry ? 'fallback' : 'failed';
          record({ stage: 'request', outcome: 'error', code: SAFE_CODES.find(code => code === failure.code) ?? 'UNKNOWN', elapsedMs: Date.now() - started });
          if (!retry) throw operation.kind === 'transcript' && failure.code === 'NOT_FOUND' && upstreamFailure ? upstreamFailure : failure;
        } finally {
          clearTimeout(timer);
          clearTimeout(routeGuardTimer);
          // Cancel any siblings left by a library Promise.all before changing egress.
          attempt.abort();
          if (transport) {
            const closing = transport.close().catch(() => undefined);
            await abortable(AbortSignal.any([deadline, AbortSignal.timeout(1000)]), () => closing).catch(() => undefined);
          }
          const elapsedMs = Date.now() - started;
          console.info(JSON.stringify({ event: 'youtube_worker_attempt', extractionId, operation: operation.kind, attempt: index + 1, egress: route.egress, slot: route.slot, elapsedMs, outcome, status, failureKind, bytesRead }));
          if (operation.kind === 'transcript') emitExtractionDiagnostic(onDiagnostic, { version: 1, kind: 'transcript', videoId: operation.id, extractionId, backend: 'worker', egress: route.egress, attempt: index + 1, slot: route.slot, recordedAt: Date.now(), elapsedMs, outcome, status, failureKind, capture: 'available', events: events.slice(), droppedEvents });
        }
        if (retry) {
          const base = bounded(env.YOUTUBE_EXTRACTION_RETRY_BASE_MS, 250, 0, 1000);
          const jitter = crypto.getRandomValues(new Uint32Array(1))[0]! / 0xffffffff;
          await wait(Math.max(retryAfter, Math.min(2000, base * 2 ** index) * (0.5 + jitter / 2)), deadline);
        }
      }
      throw lastFailure ?? new YouTubeProcessorError('UNAVAILABLE', 'YouTube extraction failed.', 503, true);
    } catch (error) {
      if (deadline.aborted) throw safeFailure(error, deadline);
      throw error;
    } finally { clearTimeout(totalTimer); }
  };
}

export const runWorkerYouTubeOperation = createWorkerExtractionRunner({ execute: executeWorkerYouTubeOperation, proxyTransport: createWorkerProxyTransport });
