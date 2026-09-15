import { setTimeout as delay } from 'node:timers/promises';
import { diagnose, type DiagnosticSink } from './diagnostics';

const RETRY_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_DELAY_MS = 2000;
const MIN_ATTEMPT_WINDOW_MS = 250;

function retryDelay(response: Response | undefined): number {
  const value = response?.headers.get('retry-after')?.trim();
  if (value) {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(value);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  return 100 + Math.floor(Math.random() * 201);
}

/** Retry only before a response body is consumed. Never replay a partially forwarded stream. */
export async function fetchMediaWithRetry(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit & { signal: AbortSignal },
  deadlineAt = Infinity,
  onDiagnostic?: DiagnosticSink,
): Promise<Response> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    init.signal.throwIfAborted();
    if (Date.now() >= deadlineAt) throw new Error('Media extraction deadline reached.');
    let response: Response | undefined;
    let failure: unknown;
    try {
      response = await fetchImpl(url, init);
    } catch (error) {
      init.signal.throwIfAborted();
      failure = error;
    }
    if (response && !RETRY_STATUSES.has(response.status)) return response;
    if (attempt === 2) {
      if (response) return response;
      throw failure;
    }
    const delayMs = retryDelay(response);
    // Never shorten Retry-After and hit an upstream rate limit sooner than requested.
    if (delayMs > MAX_DELAY_MS || Date.now() + delayMs + MIN_ATTEMPT_WINDOW_MS >= deadlineAt) {
      diagnose(onDiagnostic, { stage: 'media_retry_skipped', attempt, delayMs, status: response?.status,
        reason: delayMs > MAX_DELAY_MS ? 'retry_after_exceeds_limit' : 'insufficient_budget', error: failure });
      if (response) return response;
      throw failure;
    }
    diagnose(onDiagnostic, { stage: 'media_retry', attempt, delayMs, status: response?.status, error: failure });
    // Release the rejected response before another request; this does not consume media bytes.
    if (response?.body) void response.body.cancel().catch(() => undefined);
    await delay(delayMs, undefined, { signal: init.signal });
  }
  throw new Error('Media retry loop exhausted.');
}
