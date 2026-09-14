import { getContainer } from '@cloudflare/containers';
import { z } from 'zod';
import type { YouTubeFramesContainer } from '../youtube-frames-container';
import { ApiError } from './http';

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

async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty frame response.');
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    signal.throwIfAborted();
    while (true) {
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      length += value.byteLength;
      if (length > 12 * 1024 * 1024) throw new Error('Oversized frame response.');
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export async function getVideoFrames(env: Env, request: z.input<typeof frameRequestSchema>, signal?: AbortSignal,
  limits?: { extractionTimeoutMs: number }): Promise<VideoFrames> {
  const parsed = frameRequestSchema.safeParse(request);
  if (!parsed.success) throw new ApiError(422, 'INVALID_INPUT', 'Provide a video ID, 1 to 6 integer timestampsMs, and maxWidth from 320 to 1920.');
  const extractionTimeoutMs = z.number().int().min(5_000).max(45_000).parse(limits?.extractionTimeoutMs ?? 45_000);
  const input = { ...parsed.data, timestampsMs: [...new Set(parsed.data.timestampsMs)].sort((a, b) => a - b), extractionTimeoutMs };
  signal?.throwIfAborted();
  // Two fixed slots bound the pool. Do not replay expensive work after a timeout.
  const slot = crypto.getRandomValues(new Uint32Array(1))[0]! % 2;
  try {
    return await withTransportDeadline(extractionTimeoutMs + 5_000, signal, async deadline => {
      for (let attempt = 0; attempt < 2; attempt++) {
        deadline.throwIfAborted();
        const response = await getContainer<YouTubeFramesContainer>(env.YOUTUBE_FRAMES, `v1-${(slot + attempt) % 2}`).fetch(
          new Request('http://youtube-frames/frames', { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify(input), signal: deadline }));
        const payload = await boundedJson(response, deadline);
        deadline.throwIfAborted();
        if (!response.ok) {
          const failure = z.object({ error: z.object({ code: z.string().max(100), message: z.string().max(1000) }) }).safeParse(payload);
          // Busy means no extraction started, so trying the other slot cannot duplicate work.
          if (attempt === 0 && response.status === 503 && failure.success && failure.data.error.code === 'PROCESSOR_BUSY') continue;
          const status = response.status === 422 ? 422 : response.status === 404 ? 404 : response.status === 429 ? 429 : 503;
          throw new ApiError(status, failure.success ? failure.data.error.code : 'FRAME_EXTRACTION_FAILED',
            failure.success ? failure.data.error.message : 'YouTube frame extraction failed.');
        }
        const envelope = z.object({ value: z.unknown() }).parse(payload);
        return validateFrameResponse(input, envelope.value);
      }
      throw new ApiError(503, 'PROCESSOR_BUSY', 'Both frame processors are busy.');
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    signal?.throwIfAborted();
    throw new ApiError(503, 'FRAME_EXTRACTION_FAILED', 'YouTube frames could not be retrieved within the request limits.');
  }
}
