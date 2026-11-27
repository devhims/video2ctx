// Isolated, authenticated probes. No public data API, agent, catalog or frame cache.
import { getYouTubeMediaFrames } from '../../src/lib/youtube-media-frames';
import { jpegSize } from '../../src/lib/frame-media-io';
import { Buffer } from 'node:buffer';
import type { ExtractionAttempt } from '../../src/lib/extraction-diagnostics';
export { MediaFrameCapacity } from '../../src/durable-objects/media-frame-capacity';

const probes = {
  'a-first': { videoId: 'ZmLg3_Bv2vY', timestampsMs: [845000, 848000, 852000, 856000] },
  'a-seek': { videoId: 'ZmLg3_Bv2vY', timestampsMs: [861000] },
  'b-first': { videoId: 'aqz-KE-bpKQ', timestampsMs: [300000] },
  'b-seek': { videoId: 'aqz-KE-bpKQ', timestampsMs: [305000] },
};
export default {
  async fetch(request: Request, env: Env & { BENCHMARK_TOKEN?: string }) {
    if (!env.BENCHMARK_TOKEN || request.headers.get('Authorization') !== 'Bearer ' + env.BENCHMARK_TOKEN) return new Response(null, { status: 401 });
    const key = new URL(request.url).pathname.slice(1);
    if (request.method !== 'POST' || !Object.hasOwn(probes, key)) return new Response(null, { status: 404 });
    const input = probes[key as keyof typeof probes];
    const start = Date.now(), attempts: ExtractionAttempt[] = [];
    let frames: { timestampMs: number; width: number; height: number }[] = [];
    let errorCode: string | undefined;
    try {
      const result = await getYouTubeMediaFrames(env, { ...input, maxWidth: 1920 }, AbortSignal.any([request.signal, AbortSignal.timeout(20000)]), attempt => attempts.push(attempt));
      errorCode = result.reason;
      frames = result.frames.map(f => ({ timestampMs: f.timestampMs, ...jpegSize(Buffer.from(f.imageBase64, 'base64')) }));
    } catch (e) { errorCode = e && typeof e === 'object' && 'code' in e ? String(e.code).slice(0,64) : 'EXTRACTION_FAILED'; }
    const verified = input.timestampsMs.every(t => frames.some(f => f.timestampMs === t && f.width === 1920 && f.height === 1080));
    return Response.json({ path: 'worker-media-only', key, frames, verified, errorCode, elapsedMs: Date.now()-start, attempts: attempts.map(a => ({
      backend: a.backend, outcome: a.outcome, elapsedMs: a.elapsedMs, failureKind: a.failureKind,
      events: a.events.map(({stage,outcome,elapsedMs,playbackReuse,code,failureReason,status,formatId,width,height}) =>
        ({stage,outcome,elapsedMs,playbackReuse,code,failureReason,status,formatId,width,height})),
    })) }, {headers: {'cache-control':'no-store'}});
  },
};
