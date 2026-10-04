import { getDetails } from '../../../packages/all-things-youtube/src/index';
import { loadMediaCandidateGroup } from '../../../packages/youtube-skills/src/watch/media';
import { normalizedProxyUrls, planProxyOrder, reportProxyOutcomes, type ProxyOutcome } from './proxy-health';
import { createWorkerProxyTransport } from './youtube-worker-transport';
import { FrameMediaError, frameAbortable, frameBytes } from './frame-media-io';
import { extractionEventSchema, type ExtractionAttempt } from './extraction-diagnostics';
import { safeErrorLog } from './http';
import { openMp4FrameSource } from './mp4-frame-clip';

function mediaUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.googlevideo.com') || url.port || url.username || url.password) throw new FrameMediaError('source');
  return url.href;
}

/** Construct in workerd as well as Node; redirect modes differ between runtimes. */
export function frameMediaRangeRequest(url: string, offset: number, length: number, signal: AbortSignal): Request {
  return new Request(mediaUrl(url), { signal, redirect: 'manual', headers: {
    range: `bytes=${offset}-${offset + length - 1}`,
    'user-agent': 'com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip',
  } });
}

/** Yield resolution-ordered sources on bounded proxy routes. Closing the iterator releases its transport. */
export async function* openYouTubeFrameSources(env: Env, videoId: string, maxWidth: number, signal: AbortSignal, record: (event: ExtractionAttempt['events'][number]) => void = () => {}) {
  const urls = normalizedProxyUrls(env);
  if (!urls?.length) throw new FrameMediaError('source');
  const plan = await planProxyOrder(env, urls);
  const outcomes: Array<{ slot: number; outcome: ProxyOutcome }> = [];
  let totalBytes = 0;
  for (const slot of plan.order.slice(0, 4)) {
    signal.throwIfAborted();
    const transport = createWorkerProxyTransport(urls[slot]!);
    let answered = false, throttled = false, served = false, sourceFailed = false;
    const capture = (event: unknown) => {
      const value = event as { reason?: unknown; code?: unknown };
      const botChallenge = typeof value.reason === 'string' && /confirm.*(?:not a bot|aren.t a bot)|unusual traffic|automated requests/i.test(value.reason);
      if (botChallenge || value.code === 'RATE_LIMITED') throttled = true;
      const parsed = extractionEventSchema.safeParse({ ...value, proxySlot: slot, ...(botChallenge ? { failureReason: 'bot_challenge' } : {}) });
      if (parsed.success) record(parsed.data);
    };
    const close = () => frameAbortable(AbortSignal.timeout(1000), () => transport.close()).catch(() => undefined);
    const tracked: typeof fetch = async (input, init = {}) => {
      const active = AbortSignal.any([signal, AbortSignal.timeout(8000), ...(init.signal ? [init.signal] : [])]);
      const response = await frameAbortable(active, () => transport.fetch(input, { ...init, signal: active }));
      answered = true;
      capture({ stage: 'player', status: response.status, outcome: response.ok ? 'success' : 'error', proxySlot: slot });
      if (response.status === 429) throttled = true;
      const bytes = await frameBytes(response, 8 * 1024 * 1024, active);
      totalBytes += bytes.byteLength;
      if (totalBytes > 40 * 1024 * 1024) throw new FrameMediaError('budget');
      const headers = new Headers(response.headers);
      headers.delete('content-length'); headers.delete('content-encoding');
      return new Response([204, 205, 304].includes(response.status) ? null : bytes, { status: response.status, headers });
    };
    try {
      const options = { fetch: tracked, retry: { policy: { maxAttempts: 1, attemptTimeoutMs: 8000 } } };
      let metadata: Awaited<ReturnType<typeof getDetails>> | undefined;
      for (const profile of [1, 0]) {
        const group = await frameAbortable(signal, () => loadMediaCandidateGroup(profile, videoId, maxWidth, options, true, event => capture({ ...event,
          code: event.error ? extractionEventSchema.shape.code.safeParse(safeErrorLog(event.error).errorCode).data ?? 'UNKNOWN' : undefined })));
        if (!group) { if (throttled) break; continue; }
        // The playable source response already identifies ordinary versus live
        // content. Only older/ambiguous responses need a second metadata request.
        if (group.isLive === undefined) metadata ??= await frameAbortable(signal, () => getDetails({ videoId, ...options }));
        if (group.isLive === true || (group.isLive === undefined && metadata?.isLive)) throw new FrameMediaError('unsupported');
        const [preferred, ...alternates] = group.candidates.filter(c => c.mimeType.includes('avc1'));
        // Prefer detail first, then the progressive source that avoids adaptive range failures.
        const candidates = preferred ? [preferred, ...alternates.filter(c => c.progressive), ...alternates.filter(c => !c.progressive)] : [];
        for (const candidate of candidates) {
          // Resume here only for missing frames.
          signal.throwIfAborted();
          const url = mediaUrl(candidate.url);
          let size: number | undefined;
          const readRange = async (offset: number, length: number, discoverSize = false) => {
            signal.throwIfAborted();
            if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > 4 * 1024 * 1024) throw new FrameMediaError('budget');
            const active = AbortSignal.any([signal, AbortSignal.timeout(8000)]);
            const response = await frameAbortable(active, () => transport.fetch(frameMediaRangeRequest(url, offset, length, active)));
            answered = true;
            capture({ stage: 'media_http', status: response.status, formatId: candidate.formatId, proxySlot: slot });
            if (response.status === 429) throttled = true;
            const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
            const expectedLength = discoverSize && range ? Math.min(length, Number(range[3]) - offset) : length;
            if (response.status !== 206 || !range || expectedLength < 1 || Number(range[1]) !== offset || Number(range[2]) !== offset + expectedLength - 1
              || !Number.isSafeInteger(Number(range[3])) || Number(range[3]) < offset + expectedLength || (size !== undefined && size !== Number(range[3]))) {
              void response.body?.cancel().catch(() => undefined);
              sourceFailed = true;
              throw new FrameMediaError('source');
            }
            size = Number(range[3]);
            const bytes = await frameBytes(response, expectedLength, active);
            totalBytes += bytes.byteLength;
            if (bytes.byteLength !== expectedLength || totalBytes > 40 * 1024 * 1024) throw new FrameMediaError('budget');
            return bytes;
          };
          try {
            // The index and first fragment header normally share this prefix.
            // Reuse it instead of paying a proxy round trip for each tiny box.
            const prefix = await readRange(0, 64 * 1024, true);
            const read = (offset: number, length: number) => offset >= 0 && length > 0 && offset + length <= prefix.length
              ? Promise.resolve(prefix.slice(offset, offset + length)) : readRange(offset, length);
            const source = await openMp4FrameSource(read, size!);
            yield { ...source, slot, profile: group.profile, formatId: candidate.formatId,
              get bytesRead() { return totalBytes; },
              clip: async (time: number) => {
                try { const clip = await source.clip(time); served = true; return clip; }
                catch (error) { sourceFailed = true; throw error; }
              } };
            signal.throwIfAborted();
            if (throttled) break;
          } catch (error) {
            capture({ stage: 'media_source', outcome: 'error', formatId: candidate.formatId, code: 'MEDIA_UNAVAILABLE' });
            console.info({ event: 'media_source_candidate_failure', videoId, slot, formatId: candidate.formatId, ...safeErrorLog(error) });
            signal.throwIfAborted();
            if (error instanceof FrameMediaError && error.code === 'budget') throw error;
            if (throttled) break;
          }
        }
        if (throttled) break;
      }
    } catch (error) {
      capture({ stage: 'player', outcome: 'error', proxySlot: slot, code: extractionEventSchema.shape.code.safeParse(safeErrorLog(error).errorCode).data ?? 'UNKNOWN' });
      console.info({ event: 'media_source_route_failure', videoId, slot, ...safeErrorLog(error) });
      signal.throwIfAborted();
      if (error instanceof FrameMediaError && error.code === 'budget') throw error;
    }
    finally {
      if (throttled) outcomes.push({ slot, outcome: 'rate_limited' });
      else if (!answered && !signal.aborted) outcomes.push({ slot, outcome: 'route_failure' });
      else if (served && !sourceFailed && !signal.aborted) outcomes.push({ slot, outcome: 'success' });
      await close();
      await reportProxyOutcomes(env, plan, outcomes.splice(0));
    }
  }
  throw new FrameMediaError('unsupported');
}
