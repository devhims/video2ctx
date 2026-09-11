import { getContainer } from '@cloudflare/containers';
import { z } from 'zod';
import type { YouTubeFramesContainer } from '../youtube-frames-container';
import { ApiError } from './http';

import { frameRequestSchema, validateFrameResponse, type VideoFrames } from './youtube-frames-contract';
export { frameRequestSchema, framesSchema, validateFrameResponse, type VideoFrames } from './youtube-frames-contract';

async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty frame response.');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 12 * 1024 * 1024) throw new Error('Oversized frame response.');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export async function getVideoFrames(env: Env, request: z.input<typeof frameRequestSchema>, signal?: AbortSignal): Promise<VideoFrames> {
  const parsed = frameRequestSchema.safeParse(request);
  if (!parsed.success) throw new ApiError(422, 'INVALID_INPUT', 'Provide a video ID, 1 to 6 integer timestampsMs, and maxWidth from 320 to 1920.');
  const input = { ...parsed.data, timestampsMs: [...new Set(parsed.data.timestampsMs)].sort((a, b) => a - b) };
  signal?.throwIfAborted();
  const deadline = signal ? AbortSignal.any([signal, AbortSignal.timeout(70_000)]) : AbortSignal.timeout(70_000);
  // Two fixed slots bound the pool. Do not replay expensive work after a timeout.
  const slot = crypto.getRandomValues(new Uint32Array(1))[0]! % 2;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await getContainer<YouTubeFramesContainer>(env.YOUTUBE_FRAMES, `v1-${(slot + attempt) % 2}`).fetch(
        new Request('http://youtube-frames/frames', { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input), signal: deadline }));
      const payload = await boundedJson(response);
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
  } catch (error) {
    if (error instanceof ApiError) throw error;
    signal?.throwIfAborted();
    throw new ApiError(503, 'FRAME_EXTRACTION_FAILED', 'YouTube frames could not be retrieved within the request limits.');
  }
}
