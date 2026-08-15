import { YouTubeClientError } from './youtube-types';

export interface YouTubeRetryPolicy {
  maxAttempts: number;
  attemptTimeoutMs: number;
  baseDelayMs: number;
  maxDelayMs: number;
  retryStatuses: readonly number[];
}

export interface YouTubeRetryEvent {
  operation: string;
  attempt: number;
  maxAttempts: number;
  status?: number;
  delayMs: number;
  reason: 'response' | 'network';
}

export interface YouTubeRetryOptions {
  policy?: Partial<YouTubeRetryPolicy>;
  wait?: (delayMs: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
  onRetry?: (event: YouTubeRetryEvent) => void;
}

export interface YouTubeRequestAttempt {
  input: RequestInfo | URL;
  init?: RequestInit;
}

export interface YouTubeTransport {
  fetch(
    operation: string,
    requestFactory: (attempt: number) => YouTubeRequestAttempt | Promise<YouTubeRequestAttempt>,
    policy?: Partial<YouTubeRetryPolicy>,
  ): Promise<Response>;
}

const DEFAULT_POLICY: YouTubeRetryPolicy = {
  maxAttempts: 5,
  attemptTimeoutMs: 10_000,
  baseDelayMs: 200,
  maxDelayMs: 2_000,
  retryStatuses: [408, 425, 429, 500, 502, 503, 504],
};

function requestSignal(request: YouTubeRequestAttempt): AbortSignal | null | undefined {
  if (request.init?.signal) return request.init.signal;
  return typeof Request !== 'undefined' && request.input instanceof Request
    ? request.input.signal
    : undefined;
}

function assertAttemptTimeout(timeoutMs: number): void {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new YouTubeClientError(
      'INVALID_INPUT',
      'retry.policy.attemptTimeoutMs must be a positive integer.',
    );
  }
}

function attemptSignal(request: YouTubeRequestAttempt, timeoutMs: number): AbortSignal {
  const deadline = AbortSignal.timeout(timeoutMs);
  const existing = requestSignal(request);
  if (!existing) return deadline;

  const combined = new AbortController();
  const forwardAbort = (signal: AbortSignal) => {
    if (signal.aborted) {
      combined.abort(signal.reason);
      return;
    }
    signal.addEventListener('abort', () => combined.abort(signal.reason), { once: true });
  };
  forwardAbort(existing);
  if (!combined.signal.aborted) forwardAbort(deadline);
  return combined.signal;
}

async function runtimeWait(delayMs: number): Promise<void> {
  const runtimeScheduler = (globalThis as typeof globalThis & {
    scheduler?: { wait(delay: number): Promise<void> };
  }).scheduler;
  if (runtimeScheduler?.wait) return runtimeScheduler.wait(delayMs);
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

function retryAfterMs(response: Response, now: number): number | undefined {
  const value = response.headers.get('retry-after')?.trim();
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : undefined;
}

function retryDelay(
  response: Response | undefined,
  attempt: number,
  policy: YouTubeRetryPolicy,
  random: () => number,
  now: () => number,
): number {
  const requestedDelay = response ? retryAfterMs(response, now()) : undefined;
  if (requestedDelay !== undefined) return Math.min(policy.maxDelayMs, requestedDelay);
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * (2 ** (attempt - 1)));
  return Math.max(0, Math.round(ceiling * Math.min(1, Math.max(0, random()))));
}

export function createYouTubeTransport(options: YouTubeRetryOptions & { fetch: typeof fetch }): YouTubeTransport {
  const fetchImpl = options.fetch;
  const wait = options.wait ?? runtimeWait;
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;

  return {
    async fetch(operation, requestFactory, overrides = {}) {
      const policy: YouTubeRetryPolicy = {
        ...DEFAULT_POLICY,
        ...options.policy,
        ...overrides,
        retryStatuses: overrides.retryStatuses ?? options.policy?.retryStatuses ?? DEFAULT_POLICY.retryStatuses,
      };
      assertAttemptTimeout(policy.attemptTimeoutMs);
      const retryStatuses = new Set(policy.retryStatuses);
      let lastNetworkError: unknown;

      for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
        const request = await requestFactory(attempt);
        let response: Response | undefined;
        try {
          response = await fetchImpl(request.input, {
            ...request.init,
            signal: attemptSignal(request, policy.attemptTimeoutMs),
          });
        } catch (error) {
          lastNetworkError = error;
          if (attempt === policy.maxAttempts) {
            throw new YouTubeClientError(
              'UPSTREAM_ERROR',
              `YouTube ${operation} network request failed after ${policy.maxAttempts} attempts.`,
              { retryable: true, cause: error },
            );
          }
        }

        if (response && (!retryStatuses.has(response.status) || attempt === policy.maxAttempts)) {
          return response;
        }

        const delayMs = retryDelay(response, attempt, policy, random, now);
        options.onRetry?.({
          operation,
          attempt,
          maxAttempts: policy.maxAttempts,
          status: response?.status,
          delayMs,
          reason: response ? 'response' : 'network',
        });
        if (response?.body) await response.body.cancel().catch(() => {});
        await wait(delayMs);
      }

      throw new YouTubeClientError(
        'UPSTREAM_ERROR',
        `YouTube ${operation} retry loop exhausted.`,
        { retryable: true, cause: lastNetworkError },
      );
    },
  };
}
