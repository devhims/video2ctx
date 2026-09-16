import { downloadStoryboard, parseStoryboardSpec, readBoundedBytes, validateStoryboardOptions } from './storyboard';
import { createYouTubeTransport } from './youtube-transport';
import { WEB_PROFILE, PLAYER_PROFILES, extractInitialPlayerResponse } from './youtube-player';
import { YouTubeClientError, type StoryboardOptions, type YouTubeClientOptions } from './youtube-types';

export interface StoryboardDiagnostic {
  stage: 'player' | 'download' | 'complete';
  profile: string;
  status?: number;
  playabilityStatus?: string;
  specState?: 'valid' | 'missing' | 'malformed';
  outcome: 'selected' | 'skipped' | 'error' | 'success';
  code?: string;
  elapsedMs: number;
  sheetCount?: number;
}
export type StoryboardRequest = StoryboardOptions & YouTubeClientOptions & {
  signal?: AbortSignal;
  timeBudgetMs?: number;
  onDiagnostic?: (event: StoryboardDiagnostic) => void;
};
const object = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
const statuses = new Set(['OK', 'LOGIN_REQUIRED', 'UNPLAYABLE', 'ERROR', 'LIVE_STREAM_OFFLINE', 'CONTENT_CHECK_REQUIRED', 'AGE_CHECK_REQUIRED']);

// A playable response alone does not guarantee that this client exposes storyboards.
export async function getStoryboardWithFallback(options: StoryboardRequest) {
  validateStoryboardOptions(options);
  const timeBudgetMs = options.timeBudgetMs ?? 30_000;
  if (!Number.isSafeInteger(timeBudgetMs) || timeBudgetMs < 1) {
    throw new YouTubeClientError('INVALID_INPUT', 'timeBudgetMs must be a positive integer.');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeBudgetMs);
  const cleanupSignals: (() => void)[] = [];
  // Keep the library's Node 18 support; AbortSignal.any arrived in 18.17.
  const combineSignals = (signals: AbortSignal[]) => {
    const combined = new AbortController();
    for (const source of signals) {
      if (source.aborted) { combined.abort(source.reason); break; }
      const forward = () => combined.abort(source.reason);
      source.addEventListener('abort', forward, { once: true });
      cleanupSignals.push(() => source.removeEventListener('abort', forward));
    }
    return combined.signal;
  };
  const signal = options.signal ? combineSignals([options.signal, controller.signal]) : controller.signal;
  const emit = (event: StoryboardDiagnostic) => { try { options.onDiagnostic?.(event); } catch { /* Logs cannot fail extraction. */ } };
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const boundedFetch: typeof fetch = (input, init) => {
    signal.throwIfAborted();
    const existing = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    return fetchImpl(input, { ...init, signal: existing ? combineSignals([signal, existing]) : signal });
  };
  const wait = (delayMs: number) => new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(waitTimer); reject(signal.reason); };
    const finish = () => { signal.removeEventListener('abort', abort); resolve(); };
    const waitTimer = setTimeout(finish, delayMs);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  const transport = createYouTubeTransport({ ...options.retry, wait, fetch: boundedFetch });
  let uncertain = false;
  let malformed = false;
  let downloadError: YouTubeClientError | undefined;
  try {
    for (const profile of [...PLAYER_PROFILES, WEB_PROFILE]) {
      signal.throwIfAborted();
      const startedAt = Date.now();
      const desktop = profile === WEB_PROFILE;
      let status: number | undefined;
      let raw: Record<string, unknown>;
      try {
        const response = await transport.fetch('storyboard-player', () => ({
          input: desktop ? `https://www.youtube.com/watch?v=${options.videoId}` : 'https://youtubei.googleapis.com/youtubei/v1/player?prettyPrint=false',
          init: {
            signal,
            method: desktop ? 'GET' : 'POST',
            headers: { 'User-Agent': profile.userAgent, 'Accept-Language': `${options.language ?? 'en'}-${options.region ?? 'US'}`,
              ...(desktop ? {} : { 'Content-Type': 'application/json', 'X-YouTube-Client-Name': profile.clientNameHeader,
                'X-YouTube-Client-Version': profile.clientVersion, Origin: 'https://www.youtube.com' }) },
            ...(desktop ? {} : { body: JSON.stringify({ videoId: options.videoId, contentCheckOk: true, racyCheckOk: true,
              context: { client: { clientName: profile.clientName, clientVersion: profile.clientVersion,
                hl: options.language ?? 'en', gl: options.region ?? 'US', ...profile.context },
                user: { lockedSafetyMode: false }, request: { useSsl: true } } }) }),
          },
        }), { maxAttempts: 2, attemptTimeoutMs: 4_000 });
        status = response.status;
        if (!response.ok) {
          await response.body?.cancel();
          throw new YouTubeClientError('UPSTREAM_ERROR', 'Storyboard player request failed.', { status, retryable: true });
        }
        const text = new TextDecoder().decode(await readBoundedBytes(response, 8 * 1024 * 1024));
        raw = object(desktop ? extractInitialPlayerResponse(text) : JSON.parse(text));
      } catch (error) {
        signal.throwIfAborted();
        uncertain = true;
        emit({ stage: 'player', profile: profile.name, status, outcome: 'error',
          code: error instanceof YouTubeClientError ? error.code : 'INVALID_RESPONSE', elapsedMs: Date.now() - startedAt });
        continue;
      }
      const upstreamStatus = object(raw.playabilityStatus).status;
      const playabilityStatus = typeof upstreamStatus === 'string' && statuses.has(upstreamStatus) ? upstreamStatus : 'UNKNOWN';
      const spec = parseStoryboardSpec(raw);
      const specState = spec ? 'valid' : object(raw.storyboards).playerStoryboardSpecRenderer !== undefined ? 'malformed' : 'missing';
      emit({ stage: 'player', profile: profile.name, status, playabilityStatus, specState,
        outcome: playabilityStatus === 'OK' && spec ? 'selected' : 'skipped', elapsedMs: Date.now() - startedAt });
      if (playabilityStatus !== 'OK') { uncertain = true; continue; }
      if (!spec) { malformed ||= specState === 'malformed'; continue; }
      const downloadStartedAt = Date.now();
      try {
        const result = await downloadStoryboard(raw, options, boundedFetch);
        signal.throwIfAborted();
        emit({ stage: 'complete', profile: profile.name, outcome: 'success', sheetCount: result.sheets.length, elapsedMs: Date.now() - startedAt });
        return result;
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof YouTubeClientError && error.code === 'INVALID_INPUT') throw error;
        downloadError = error instanceof YouTubeClientError ? error
          : new YouTubeClientError('UPSTREAM_ERROR', 'Storyboard download failed.', { retryable: true });
        emit({ stage: 'download', profile: profile.name, outcome: 'error', code: downloadError.code,
          status: downloadError.status, elapsedMs: Date.now() - downloadStartedAt });
      }
    }
    if (downloadError) throw downloadError;
    if (malformed) throw new YouTubeClientError('INVALID_RESPONSE', 'YouTube returned malformed storyboard metadata.', { retryable: true });
    if (uncertain) throw new YouTubeClientError('UNAVAILABLE', 'Storyboards could not be verified across YouTube clients.', { retryable: true });
    throw new YouTubeClientError('NOT_FOUND', 'No storyboard is available on the checked YouTube clients.');
  } catch (error) {
    if (signal.aborted) throw new YouTubeClientError('UNAVAILABLE', 'Storyboard request was cancelled or exceeded its time budget.', { retryable: true });
    throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
    for (const cleanup of cleanupSignals) cleanup();
  }
}
