import { Buffer } from 'node:buffer';
import type { VideoFrames } from './youtube-frames-contract';
import { acquireFrameLease } from './frame-media-admission';
import { openYouTubeFrameSources } from './frame-media-source';
import { FrameMediaError, frameAbortable, frameBytes, jpegSize } from './frame-media-io';
import { emitExtractionDiagnostic, type ExtractionAttempt, type ExtractionDiagnosticSink } from './extraction-diagnostics';
import { linkVisualExtraction } from './visual-diagnostics';

type Input = { videoId: string; timestampsMs: number[]; maxWidth: number };
export type MediaFramesAttempt = { frames: VideoFrames['frames']; reason?: FrameMediaError['code'] };

/** Best-effort primary decoder. Completed frames survive any later failure or timeout. */
export async function getYouTubeMediaFrames(env: Env, input: Input, signal: AbortSignal, diagnostic?: ExtractionDiagnosticSink,
  onFrame?: (frame: VideoFrames['frames'][number]) => void): Promise<MediaFramesAttempt> {
  const started = Date.now(), extractionId = crypto.randomUUID();
  const frames: VideoFrames['frames'] = [], events: ExtractionAttempt['events'] = [];
  let job: Awaited<ReturnType<typeof acquireFrameLease>> | undefined;
  let source: Exclude<Awaited<ReturnType<ReturnType<typeof openYouTubeFrameSources>['next']>>['value'], void> | undefined;
  let droppedEvents = 0;
  const record = (event: ExtractionAttempt['events'][number]) => { if (events.length < 54) events.push(event); else droppedEvents++; };
  let reason: FrameMediaError['code'] | undefined, imageBytes = 0, cursor = 0, stop = false;
  linkVisualExtraction(extractionId, 1);
  try {
    job = await acquireFrameLease(env, 'media-job', signal);
    record({ stage: 'media_admission', outcome: 'success', elapsedMs: Date.now() - started });
    let sourceAttempts = 0;
    for await (const candidate of openYouTubeFrameSources(env, input.videoId, input.maxWidth, signal, record)) {
      source = candidate;
      sourceAttempts++;
      cursor = 0;
      const missing = input.timestampsMs.filter(time => !frames.some(frame => frame.timestampMs === time));
      let sourceStopped = false;
      record({ stage: 'media_source', outcome: 'success', elapsedMs: Date.now() - started,
        profile: source.profile, formatId: source.formatId, width: source.width, height: source.height, inputBytes: source.bytesRead });
      const selected = source;
      const work = async () => {
        while (!stop && !sourceStopped && cursor < missing.length) {
          const timestampMs = missing[cursor++]!;
          let lease: Awaited<ReturnType<typeof acquireFrameLease>> | undefined;
          let settled = true, clipRejected = false;
          let stage: 'media_source' | 'media_decode' = 'media_source';
          const frameStarted = Date.now();
          try {
            signal.throwIfAborted();
            const clip = await selected.clip(timestampMs / 1000);
            signal.throwIfAborted();
            stage = 'media_decode';
            lease = await acquireFrameLease(env, 'media-frame', signal);
            settled = false;
            const pending = env.MEDIA.input(new Response(clip.bytes).body!)
              .transform({ width: input.maxWidth, fit: 'scale-down' })
              .output({ mode: 'frame', time: `${clip.time}s`, format: 'jpg' }).response().then(response => {
                if (signal.aborted) void response.body?.cancel().catch(() => undefined);
                return response;
              });
            const response = await frameAbortable(signal, () => pending);
            if (!response.ok) {
              void response.body?.cancel().catch(() => undefined);
              // A rejected clip does not establish an outage for other timestamps.
              clipRejected = response.status === 422;
              throw new FrameMediaError(response.status === 429 ? 'throttled' : 'decode');
            }
            const bytes = await frameBytes(response, 4 * 1024 * 1024, signal);
            settled = true;
            const dimensions = jpegSize(bytes);
            if (dimensions.width < 1 || dimensions.width > input.maxWidth || dimensions.height < 1 || dimensions.height > 16384
              || imageBytes + bytes.byteLength > 8 * 1024 * 1024) throw new FrameMediaError('budget');
            imageBytes += bytes.byteLength;
            frames.push({ timestampMs, mimeType: 'image/jpeg', ...dimensions, sourceWidth: selected.width,
              sourceHeight: selected.height, imageBase64: Buffer.from(bytes).toString('base64') });
            onFrame?.(frames.at(-1)!);
            record({ stage: 'media_decode', timestampMs, formatId: selected.formatId, proxySlot: selected.slot, elapsedMs: Date.now() - frameStarted,
              inputBytes: clip.bytes.byteLength, outputBytes: bytes.byteLength, outcome: 'success' });
          } catch (error) {
            const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
            const throttled = code === 9423 || code === '9423' || code === 'throttled';
            reason = throttled ? 'throttled' : error instanceof FrameMediaError ? error.code : stage === 'media_source' ? 'source' : 'decode';
            record({ stage, timestampMs, formatId: selected.formatId, proxySlot: selected.slot, elapsedMs: Date.now() - frameStarted,
              outcome: 'error', code: throttled ? 'RATE_LIMITED' : 'FRAME_EXTRACTION_FAILED' });
            if (throttled) await lease?.throttle();
            if (throttled || signal.aborted || reason === 'capacity' || reason === 'budget' || (reason === 'decode' && !clipRejected)) stop = true;
            if (reason === 'source' || reason === 'unsupported') sourceStopped = true;
          } finally {
            // An aborted binding call may still be decoding. Its lease expires instead of freeing capacity early.
            if (lease && (settled || !signal.aborted)) await lease.release();
          }
        }
      };
      // The account-wide eight-call admission limit still covers every decoder.
      await Promise.all(Array.from({ length: Math.min(4, missing.length) }, () => work()));
      if (frames.length === input.timestampsMs.length) { reason = undefined; break; }
      if (stop || signal.aborted || sourceAttempts >= 3) break;
    }
  } catch (error) {
    const exhausted = error instanceof FrameMediaError && error.code === 'unsupported';
    if (!exhausted || !reason) reason = error instanceof FrameMediaError ? error.code : 'source';
    record({ stage: job ? 'media_source' : 'media_admission', outcome: 'error', elapsedMs: Date.now() - started,
      code: reason === 'capacity' ? 'RATE_LIMITED' : 'FRAME_EXTRACTION_FAILED' });
  }
  finally {
    if (job) await job.release();
    const outcome = frames.length === input.timestampsMs.length ? 'success' : 'fallback';
    emitExtractionDiagnostic(diagnostic, { version: 1, kind: 'frames', backend: 'media', egress: 'proxy', videoId: input.videoId,
      extractionId, attempt: 1, slot: source?.slot ?? 0, recordedAt: Date.now(), elapsedMs: Date.now() - started,
      outcome, capture: 'available', events, droppedEvents, failureKind: signal.aborted ? 'timeout' : undefined });
    console.info(JSON.stringify({ event: 'youtube_media_frames', extractionId, videoId: input.videoId, outcome,
      elapsedMs: Date.now() - started, completed: frames.length, requested: input.timestampsMs.length,
      bytesRead: source?.bytesRead ?? 0, imageBytes, reason }));
  }
  return { frames: frames.sort((a, b) => a.timestampMs - b.timestampMs), reason };
}
