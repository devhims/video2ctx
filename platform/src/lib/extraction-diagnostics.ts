import { z } from 'zod';

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const metric = z.number().nonnegative().max(Number.MAX_SAFE_INTEGER);
// Deliberately no free-form strings, error messages, URLs, headers, or stderr.
export const extractionEventSchema = z.object({
  stage: z.enum(['player', 'player_response', 'download', 'complete', 'request', 'image_normalized',
    'media_candidates', 'media_http', 'media_transfer', 'media_retry', 'media_retry_skipped', 'ffmpeg', 'ffmpeg_success']),
  profile: z.enum(['IOS', 'ANDROID_VR', 'MWEB', 'WEB', 'ios', 'android', 'android_vr', 'mweb', 'web']).optional(),
  outcome: z.enum(['selected', 'skipped', 'error', 'success']).optional(),
  playabilityStatus: z.enum(['OK', 'LOGIN_REQUIRED', 'UNPLAYABLE', 'ERROR', 'LIVE_STREAM_OFFLINE', 'CONTENT_CHECK_REQUIRED', 'AGE_CHECK_REQUIRED', 'UNKNOWN']).optional(),
  specState: z.enum(['valid', 'missing', 'malformed']).optional(),
  code: z.enum(['INVALID_INPUT', 'INVALID_RESPONSE', 'NOT_FOUND', 'UNAVAILABLE', 'UPSTREAM_ERROR', 'AUTH_REQUIRED',
    'RATE_LIMITED', 'FRAME_EXTRACTION_FAILED', 'FRAME_TIMEOUT', 'FRAME_CANCELLED', 'MEDIA_UNAVAILABLE', 'UNKNOWN']).optional(),
  inputFormat: z.enum(['webp', 'jpeg']).optional(), outputFormat: z.enum(['webp', 'jpeg']).optional(),
  status: z.number().int().min(100).max(599).optional(), elapsedMs: metric.optional(),
  timestampMs: count.optional(), candidateIndex: count.optional(), candidateCount: count.optional(),
  attempt: count.optional(), delayMs: metric.optional(), sheetCount: count.optional(),
  width: count.optional(), height: count.optional(), sourceWidth: count.optional(), sourceHeight: count.optional(),
  formatId: count.optional(), inputBytes: count.optional(), outputBytes: count.optional(),
  exitCode: z.number().int().min(-255).max(255).optional(),
});

export const extractionAttemptSchema = z.object({
  version: z.literal(1), kind: z.enum(['storyboard', 'frames']), videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/),
  extractionId: z.string().uuid(), attempt: z.number().int().min(1).max(4), slot: z.number().int().min(0).max(3),
  recordedAt: count, elapsedMs: metric, status: z.number().int().min(100).max(599).optional(),
  outcome: z.enum(['success', 'failed', 'fallback', 'transport_error']),
  failureKind: z.enum(['timeout', 'canceled', 'transport', 'invalid_response', 'upstream']).optional(),
  capture: z.enum(['available', 'missing', 'invalid', 'unavailable']),
  events: z.array(extractionEventSchema).max(64), droppedEvents: count,
});
export const storedExtractionDiagnosticSchema = extractionAttemptSchema.extend({ toolCallId: z.string().min(1).max(300) });
export type ExtractionAttempt = z.infer<typeof extractionAttemptSchema>;
export type ExtractionDiagnosticSink = (attempt: ExtractionAttempt) => void;
export type StoredExtractionDiagnostic = z.infer<typeof storedExtractionDiagnosticSchema>;

export function extractionFailureKind(error: unknown, signal?: AbortSignal): ExtractionAttempt['failureKind'] {
  const value = error as { name?: unknown; code?: unknown } | null;
  const reason = signal?.reason as { name?: unknown; code?: unknown } | undefined;
  if (value?.code === 'FRAME_TIMEOUT' || reason?.name === 'TimeoutError' || reason?.code === 'FRAME_TIMEOUT') return 'timeout';
  if (signal?.aborted || value?.code === 'FRAME_CANCELLED') return 'canceled';
  if (value?.code === 'INVALID_PROCESSOR_RESPONSE' || value?.name === 'ZodError') return 'invalid_response';
  return typeof value?.code === 'string' ? 'upstream' : 'transport';
}

export function extractionCapture(payload: unknown): Pick<ExtractionAttempt, 'capture' | 'events' | 'droppedEvents'> {
  const envelope = z.object({ diagnostics: z.unknown().optional() }).safeParse(payload);
  if (!envelope.success || envelope.data.diagnostics === undefined) return { capture: 'missing', events: [], droppedEvents: 0 };
  const parsed = z.object({ version: z.literal(1), events: z.array(z.unknown()).max(64), droppedEvents: count }).safeParse(envelope.data.diagnostics);
  if (!parsed.success) return { capture: 'invalid', events: [], droppedEvents: 0 };
  const events: z.infer<typeof extractionEventSchema>[] = [];
  let droppedEvents = parsed.data.droppedEvents;
  for (const item of parsed.data.events) {
    const event = extractionEventSchema.safeParse(item);
    if (event.success) events.push(event.data);
    else droppedEvents++;
  }
  return { capture: 'available', events, droppedEvents: Math.min(droppedEvents, Number.MAX_SAFE_INTEGER) };
}

/** A failed diagnostic sink must never retry, charge, or fail extraction. */
export function emitExtractionDiagnostic(sink: ExtractionDiagnosticSink | undefined, event: ExtractionAttempt) {
  try { sink?.(extractionAttemptSchema.parse(event)); } catch { /* Best effort, never include error text. */ }
}
