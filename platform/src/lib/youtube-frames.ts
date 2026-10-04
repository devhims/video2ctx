import { getYouTubeMediaFrames } from './youtube-media-frames';
import { acquireFrameLease } from './frame-media-admission';
import { Buffer } from 'node:buffer';
import { visualSpan, countVisualWork, linkVisualExtraction } from './visual-diagnostics';
import { boundedContainerJson } from './bounded-container-json';
import { extractionCapture, extractionFailureKind, emitExtractionDiagnostic, type ExtractionAttempt, type ExtractionDiagnosticSink } from './extraction-diagnostics';
import { getContainer } from '@cloudflare/containers';
import { z } from 'zod';
import type { YouTubeFramesContainer } from '../youtube-frames-container';
import { ApiError, safeErrorLog } from './http';
import { normalizedProxyUrls, planProxyOrder, reportProxyOutcomes, type ProxyOutcome } from './proxy-health';

import { frameRequestSchema, validateFrameResponse, type VideoFrames } from './youtube-frames-contract';
export { frameRequestSchema, framesSchema, validateFrameResponse, type VideoFrames } from './youtube-frames-contract';

/** Per-proxy outcomes from a frames attempt's stored diagnostics. Exported for tests. */
export function frameProxyOutcomes(events: ExtractionAttempt['events'], succeeded: boolean, failureCode?: string): Array<{ slot: number; outcome: ProxyOutcome }> {
  // The container logs a proxy event when it selects a slot, and another if that route fails.
  // Player and media events in between belong to the selected slot. A 429 or bot challenge there
  // means YouTube throttled this exit, even when the job later reports MEDIA_UNAVAILABLE.
  const slots = new Map<number, { throttled: boolean; routeFailed: boolean }>();
  let selected: number | undefined;
  for (const event of events) {
    if (event.stage === 'proxy' && event.proxySlot !== undefined) {
      const state = slots.get(event.proxySlot) ?? { throttled: false, routeFailed: false };
      slots.set(event.proxySlot, state);
      if (event.code === 'PROXY_TUNNEL_FAILED' || event.failureReason === 'proxy_tunnel_failed') {
        state.routeFailed = true;
        if (selected === event.proxySlot) selected = undefined;
      } else selected = event.proxySlot;
      continue;
    }
    // A player 429 throws before player_response is emitted, so it is stored as a player event
    // whose nested error kept its RATE_LIMITED code but lost its status in serialization.
    if (selected !== undefined && (event.status === 429 || event.code === 'RATE_LIMITED' || event.failureReason === 'bot_challenge')) {
      slots.get(selected)!.throttled = true;
    }
  }
  if (selected !== undefined && failureCode === 'RATE_LIMITED') slots.get(selected)!.throttled = true;
  const outcomes: Array<{ slot: number; outcome: ProxyOutcome }> = [];
  for (const [slot, state] of slots) {
    // A job that still finished on its proxy proves the route works; one throttled response is not a ban.
    if (slot === selected && succeeded) outcomes.push({ slot, outcome: 'success' });
    else if (state.throttled) outcomes.push({ slot, outcome: 'rate_limited' });
    else if (state.routeFailed) outcomes.push({ slot, outcome: 'route_failure' });
  }
  return outcomes;
}

async function withTransportDeadline<T>(timeoutMs: number, signal: AbortSignal | undefined,
  work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort(signal?.reason);
  const timer = setTimeout(() => controller.abort(new ApiError(503, 'FRAME_TIMEOUT',
    'Frame extraction did not return within its allotted time.')), timeoutMs);
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(controller.signal.reason);
  controller.signal.addEventListener('abort', onAbort, { once: true });
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  try {
    return await Promise.race([aborted, Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return work(controller.signal);
    })]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    controller.signal.removeEventListener('abort', onAbort);
    controller.abort();
  }
}


export async function getVideoFrames(env: Env, request: z.input<typeof frameRequestSchema>, signal?: AbortSignal,
  limits?: { extractionTimeoutMs: number }, onDiagnostic?: ExtractionDiagnosticSink): Promise<VideoFrames> {
  return visualSpan('extraction', () => env.YOUTUBE_FRAMES_BACKEND === 'media'
    ? getFramesWithMedia(env, request, signal, limits, onDiagnostic)
    : getVideoFramesImpl(env, request, signal, limits, onDiagnostic));
}

async function getVideoFramesImpl(env: Env, request: z.input<typeof frameRequestSchema>, signal?: AbortSignal,
  limits?: { extractionTimeoutMs: number }, onDiagnostic?: ExtractionDiagnosticSink, onTransportSettled?: (settled: boolean) => void): Promise<VideoFrames> {
  const parsed = frameRequestSchema.safeParse(request);
  if (!parsed.success) throw new ApiError(422, 'INVALID_INPUT', 'Provide a video ID, 1 to 6 integer timestampsMs, and maxWidth from 320 to 1920.');
  const extractionTimeoutMs = z.number().int().min(5_000).max(45_000).parse(limits?.extractionTimeoutMs ?? 45_000);
  const input = { ...parsed.data, timestampsMs: [...new Set(parsed.data.timestampsMs)].sort((a, b) => a - b), extractionTimeoutMs };
  signal?.throwIfAborted();
  // Two fixed slots bound the pool. Do not replay expensive work after a timeout.
  const extractionId = crypto.randomUUID();
  const startedAt = Date.now();
  let activeSlot: number | undefined;
  let responseStatus: number | undefined;
  let stage = 'container_transport';
  let failureKind: ExtractionAttempt['failureKind'];
  let finishAttempt: (outcome?: ExtractionAttempt['outcome']) => void = () => {};
  const slot = crypto.getRandomValues(new Uint32Array(1))[0]! % 2;
  // The container walks this order and skips proxies that fail, so cooling proxies come last.
  const pool = normalizedProxyUrls(env);
  const proxyPlan = pool?.length ? await planProxyOrder(env, pool) : undefined;
  const proxyOutcomes: Array<{ slot: number; outcome: ProxyOutcome }> = [];
  try {
    return await withTransportDeadline(extractionTimeoutMs + 5_000, signal, async deadline => {
      for (let attempt = 0; attempt < 2; attempt++) {
        deadline.throwIfAborted();
        activeSlot = (slot + attempt) % 2;
        stage = 'container_transport';
        responseStatus = undefined;
        const attemptStartedAt = Date.now();
        failureKind = undefined;
        let outcome: ExtractionAttempt['outcome'] = 'transport_error';
        let capture: Pick<ExtractionAttempt, 'capture' | 'events' | 'droppedEvents'> = { capture: 'unavailable', events: [], droppedEvents: 0 };
        let recorded = false;
        finishAttempt = override => {
          if (recorded) return;
          recorded = true;
          emitExtractionDiagnostic(onDiagnostic, { version: 1, kind: 'frames', videoId: input.videoId, extractionId,
            attempt: attempt + 1, slot: activeSlot!, recordedAt: Date.now(), elapsedMs: Date.now() - attemptStartedAt,
            status: responseStatus, outcome: override ?? outcome, failureKind, ...capture });
        };
        try {
          onTransportSettled?.(false);
          countVisualWork('containerAttempts');
          linkVisualExtraction(extractionId, attempt + 1);
          const response = await getContainer<YouTubeFramesContainer>(env.YOUTUBE_FRAMES, `v1-${(slot + attempt) % 2}`).fetch(
            new Request('http://youtube-frames/frames', { method: 'POST', headers: { 'content-type': 'application/json', 'x-extraction-id': extractionId,
              ...(proxyPlan ? { 'x-proxy-order': proxyPlan.order.join(',') } : {}) },
              body: JSON.stringify(input), signal: deadline }));
          responseStatus = response.status;
          stage = 'container_response';
          const payload = await boundedContainerJson(response, deadline);
          onTransportSettled?.(true);
          capture = extractionCapture(payload);
          outcome = 'failed';
          if (response.ok || response.status !== 503 || !isBusy(payload)) {
            proxyOutcomes.push(...frameProxyOutcomes(capture.events, response.ok, errorCode(payload)));
          }
          deadline.throwIfAborted();
          if (!response.ok) {
            const failure = z.object({ error: z.object({ code: z.string().max(100), message: z.string().max(1000) }) }).safeParse(payload);
            // Busy means no extraction started, so trying the other slot cannot duplicate work.
            if (attempt === 0 && response.status === 503 && failure.success && failure.data.error.code === 'PROCESSOR_BUSY') { outcome = 'fallback'; continue; }
            const status = response.status === 422 ? 422 : response.status === 404 ? 404 : response.status === 429 ? 429 : 503;
            throw new ApiError(status, failure.success ? failure.data.error.code : 'FRAME_EXTRACTION_FAILED',
              failure.success ? failure.data.error.message : 'YouTube frame extraction failed.', { extractionId });
          }
          const envelope = z.object({ value: z.unknown() }).parse(payload);
          const result = validateFrameResponse(input, envelope.value);
          outcome = 'success';
          return result;
        } catch (error) {
          failureKind = extractionFailureKind(error, deadline);
          throw error;
        } finally {
          finishAttempt();
        }
      }
      throw new ApiError(503, 'PROCESSOR_BUSY', 'Both frame processors are busy.');
    });
  } catch (error) {
    failureKind = extractionFailureKind(error, signal);
    finishAttempt('transport_error');
    console.error({ event: 'youtube_frames_request_failure', extractionId, videoId: input.videoId,
      slot: activeSlot, stage, status: responseStatus, elapsedMs: Date.now() - startedAt, ...safeErrorLog(error) });
    if (error instanceof ApiError) throw new ApiError(error.status, error.code, error.message, { extractionId });
    signal?.throwIfAborted();
    throw new ApiError(503, 'FRAME_EXTRACTION_FAILED', 'YouTube frames could not be retrieved within the request limits.', { extractionId });
  } finally {
    if (proxyPlan) await reportProxyOutcomes(env, proxyPlan, proxyOutcomes);
  }
}

function errorCode(payload: unknown): string | undefined {
  const parsed = z.object({ error: z.object({ code: z.string().max(100) }) }).safeParse(payload);
  return parsed.success ? parsed.data.error.code : undefined;
}

function isBusy(payload: unknown): boolean {
  return errorCode(payload) === 'PROCESSOR_BUSY';
}


/** Both backends share one budget. Never fetch completed Media timestamps again. */
async function getFramesWithMedia(env: Env, request: z.input<typeof frameRequestSchema>, signal?: AbortSignal,
  limits?: { extractionTimeoutMs: number }, diagnostic?: ExtractionDiagnosticSink): Promise<VideoFrames> {
  const parsed = frameRequestSchema.safeParse(request);
  if (!parsed.success) throw new ApiError(422, 'INVALID_INPUT', 'Provide a video ID, 1 to 6 integer timestampsMs, and maxWidth from 320 to 1920.');
  const input = { ...parsed.data, timestampsMs: [...new Set(parsed.data.timestampsMs)].sort((a, b) => a - b) };
  const budget = z.number().int().min(5000).max(45000).parse(limits?.extractionTimeoutMs ?? 45000);
  const started = Date.now();
  return withTransportDeadline(budget + 5000, signal, async deadline => {
    let frames: VideoFrames['frames'] = [];
    // Reserve at least ten extraction seconds for FFmpeg recovery.
    const mediaBudget = Math.min(20000, budget - 10000);
    if (mediaBudget >= 5000) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new DOMException('Media deadline', 'TimeoutError')), mediaBudget);
      try {
        const result = await getYouTubeMediaFrames(env, input, AbortSignal.any([deadline, controller.signal]), diagnostic);
        frames = result.frames;
      } finally { clearTimeout(timer); controller.abort(); }
    }
    deadline.throwIfAborted();
    const missing = input.timestampsMs.filter(time => !frames.some(frame => frame.timestampMs === time));
    let failures: VideoFrames['failures'] = [];
    const warnings: string[] = [];
    let fallbackError: unknown;
    if (missing.length) {
      let lease: Awaited<ReturnType<typeof acquireFrameLease>> | undefined;
      let finished = false, dispatched = false;
      try {
        lease = await acquireFrameLease(env, 'ffmpeg-job', deadline);
        const remaining = budget - (Date.now() - started);
        if (remaining < 5000) throw new ApiError(503, 'FRAME_TIMEOUT', 'Frame extraction exhausted its allotted time.');
        dispatched = true;
        const fallback = await getVideoFramesImpl(env, { ...input, timestampsMs: missing }, deadline,
          { extractionTimeoutMs: Math.min(45000, remaining) }, diagnostic, settled => { finished = settled; });
        finished = true;
        let bytes = frames.reduce((sum, frame) => sum + Buffer.byteLength(frame.imageBase64, 'base64'), 0);
        for (const frame of fallback.frames) {
          const size = Buffer.byteLength(frame.imageBase64, 'base64');
          if (bytes + size <= 8 * 1024 * 1024) { frames.push(frame); bytes += size; }
        }
        failures = fallback.failures;
        warnings.push(...fallback.meta.warnings);
      } catch (error) { fallbackError = error; }
      finally {
        // Keep uncertain timeouts leased until expiry; otherwise an abandoned process could exceed admission.
        if (lease && (!dispatched || finished)) await lease.release();
      }
    }
    deadline.throwIfAborted();
    if (!frames.length) throw fallbackError instanceof ApiError ? fallbackError
      : new ApiError(503, 'FRAME_EXTRACTION_FAILED', 'YouTube frames could not be retrieved within the request limits.');
    const uncovered = input.timestampsMs.filter(time => !frames.some(frame => frame.timestampMs === time));
    failures = uncovered.map(timestampMs => failures.find(failure => failure.timestampMs === timestampMs) ?? {
      timestampMs, code: 'FRAME_EXTRACTION_FAILED', message: 'The requested frame could not be extracted within the request limits.', retryable: true,
    });
    if (failures.length) warnings.push('Some requested frames could not be extracted.');
    if (frames.some(frame => (frame.sourceHeight ?? 0) > 0 && (frame.sourceHeight ?? 0) < 720)) {
      warnings.push('Best-effort media fallback produced frames below 720p.');
    }
    return validateFrameResponse(input, { videoId: input.videoId, frames: frames.sort((a, b) => a.timestampMs - b.timestampMs), failures,
      meta: { partial: failures.length > 0, warnings: [...new Set(warnings)].slice(0, 20),
        fetchedAt: new Date().toISOString(), source: 'video2ctx' } });
  });
}
