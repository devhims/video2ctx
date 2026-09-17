import { boundedContainerJson } from './bounded-container-json';
import { extractionCapture, extractionFailureKind, emitExtractionDiagnostic, type ExtractionAttempt, type ExtractionDiagnosticSink } from './extraction-diagnostics';
import { getContainer } from '@cloudflare/containers';
import { z } from 'zod';
import type { YouTubeFramesContainer } from '../youtube-frames-container';
import { ApiError, safeErrorLog } from './http';

import { frameRequestSchema, validateFrameResponse, type VideoFrames } from './youtube-frames-contract';
export { frameRequestSchema, framesSchema, validateFrameResponse, type VideoFrames } from './youtube-frames-contract';

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
          const response = await getContainer<YouTubeFramesContainer>(env.YOUTUBE_FRAMES, `v1-${(slot + attempt) % 2}`).fetch(
            new Request('http://youtube-frames/frames', { method: 'POST', headers: { 'content-type': 'application/json', 'x-extraction-id': extractionId },
              body: JSON.stringify(input), signal: deadline }));
          responseStatus = response.status;
          stage = 'container_response';
          const payload = await boundedContainerJson(response, deadline);
          capture = extractionCapture(payload);
          outcome = 'failed';
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
  }
}
