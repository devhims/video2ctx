import { getDetails } from '../../../packages/all-things-youtube/src/index';
import { loadMediaCandidateGroup } from '../../../packages/youtube-skills/src/watch/media';
import { normalizedProxyUrls, planProxyOrder, reportProxyOutcomes, type ProxyOutcome } from './proxy-health';
import { createWorkerProxyTransport } from './youtube-worker-transport';
import { FrameMediaError, frameAbortable, frameBytes } from './frame-media-io';
import { openMp4FrameSource } from './mp4-frame-clip';

function mediaUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.googlevideo.com') || url.port || url.username || url.password) throw new FrameMediaError('source');
  return url.href;
}

/** Resolve and read on one proxy route. Source URLs never leave this request-scoped closure. */
export async function openYouTubeFrameSource(env: Env, videoId: string, maxWidth: number, signal: AbortSignal) {
  const urls = normalizedProxyUrls(env);
  if (!urls?.length) throw new FrameMediaError('source');
  const plan = await planProxyOrder(env, urls);
  const outcomes: Array<{ slot: number; outcome: ProxyOutcome }> = [];
  let totalBytes = 0;
  for (const slot of plan.order.slice(0, 2)) {
    signal.throwIfAborted();
    const transport = createWorkerProxyTransport(urls[slot]!);
    let keep = false, answered = false, throttled = false;
    const close = () => frameAbortable(AbortSignal.timeout(1000), () => transport.close()).catch(() => undefined);
    const tracked: typeof fetch = async (input, init = {}) => {
      const active = AbortSignal.any([signal, AbortSignal.timeout(8000), ...(init.signal ? [init.signal] : [])]);
      const response = await frameAbortable(active, () => transport.fetch(input, { ...init, signal: active }));
      answered = true;
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
      const video = await frameAbortable(signal, () => getDetails({ videoId, ...options }));
      // Archived and uncertain broadcasts retain the existing container verification path.
      if (video.isLive) throw new FrameMediaError('unsupported');
      for (const profile of [1, 0]) {
        const group = await frameAbortable(signal, () => loadMediaCandidateGroup(profile, videoId, maxWidth, options, true));
        for (const candidate of group?.candidates.filter(c => c.mimeType.includes('avc1')) ?? []) {
          const url = mediaUrl(candidate.url);
          let size: number | undefined;
          const read = async (offset: number, length: number) => {
            signal.throwIfAborted();
            if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > 4 * 1024 * 1024) throw new FrameMediaError('budget');
            const active = AbortSignal.any([signal, AbortSignal.timeout(8000)]);
            const response = await frameAbortable(active, () => transport.fetch(url, { signal: active, redirect: 'error',
              headers: { range: `bytes=${offset}-${offset + length - 1}`, 'user-agent': 'com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip' } }));
            answered = true;
            if (response.status === 429) throttled = true;
            const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
            if (response.status !== 206 || !range || Number(range[1]) !== offset || Number(range[2]) !== offset + length - 1
              || !Number.isSafeInteger(Number(range[3])) || Number(range[3]) < offset + length || (size !== undefined && size !== Number(range[3]))) {
              void response.body?.cancel().catch(() => undefined);
              throw new FrameMediaError('source');
            }
            size = Number(range[3]);
            const bytes = await frameBytes(response, length, active);
            totalBytes += bytes.byteLength;
            if (bytes.byteLength !== length || totalBytes > 40 * 1024 * 1024) throw new FrameMediaError('budget');
            return bytes;
          };
          try {
            await read(0, 16);
            const source = await openMp4FrameSource(read, size!);
            keep = true;
            return { ...source, slot, profile: group!.profile, formatId: candidate.formatId,
              get bytesRead() { return totalBytes; }, close: async () => {
                outcomes.push({ slot, outcome: throttled ? 'rate_limited' : 'success' });
                await close(); await reportProxyOutcomes(env, plan, outcomes);
              } };
          } catch { signal.throwIfAborted(); }
        }
      }
    } catch { signal.throwIfAborted(); }
    finally {
      if (!keep) {
        if (throttled) outcomes.push({ slot, outcome: 'rate_limited' });
        else if (!answered && !signal.aborted) outcomes.push({ slot, outcome: 'route_failure' });
        await close();
        await reportProxyOutcomes(env, plan, outcomes.splice(0));
      }
    }
  }
  throw new FrameMediaError('unsupported');
}
