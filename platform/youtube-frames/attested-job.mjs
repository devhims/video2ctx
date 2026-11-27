// This job runs under the frames container's ordinary admission gate, process group and hard deadline.
import { once } from 'node:events';
import { currentProxyExit, fixedPlaybackRoute, playbackReuseMode } from './playback-cache.mjs';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SabrStream } from 'googlevideo/sabr-stream';
import { buildSabrFormat, Logger } from 'googlevideo/utils';
import { jpegDimensions } from './dist/jpeg.mjs';
import { MAX_IMAGE_BYTES, parseFrameRequest, parseProxyOrder } from './contract.mjs';
import { createFrameTransport, proxyConnections } from './egress.mjs';

Logger.getInstance().setLogLevels();
const directory = process.argv[2];
const frames = [];
const diagnostic = fields => console.error(JSON.stringify({ event: 'frame_diagnostic', profile: 'mweb', ...fields }));

// Never propagate child stderr; extractor errors can contain signed URLs or proxy credentials.
function run(command, args, input, signal, maxBuffer) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { signal, maxBuffer, encoding: 'buffer', killSignal: 'SIGKILL' }, (error, output) => {
      if (error) reject(new Error('Playback subprocess failed'));
      else resolve(output);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

async function resolvePlayback(videoId, proxy, signal, mobileConfig, returnConfig) {
  const script = fileURLToPath(new URL('./attested-player.py', import.meta.url));
  const json = await run('python3', [script], JSON.stringify({ videoId, proxy, mobileConfig, returnConfig }), signal, 4 * 1024 * 1024);
  return JSON.parse(json.toString());
}

// Locate the displayed frame by its presentation time; inspecting packet headers avoids
// decoding every frame in a segment before FFmpeg extracts the selected JPEG.
async function frameTimes(segment, signal) {
  const output = await run('ffprobe', ['-v', 'error', '-protocol_whitelist', 'pipe', '-threads', '2',
    '-f', 'mov', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time',
    '-of', 'json', '-i', 'pipe:0'], segment, signal, 512 * 1024);
  return (JSON.parse(output.toString()).packets ?? []).map(packet => Number(packet.pts_time) * 1000)
    .filter(Number.isFinite).sort((a, b) => a - b);
}

async function decode(segment, ptsMs, timestampMs, format, signal) {
  const filter = `select=between(t\\,${ptsMs / 1000 - 0.0001}\\,${ptsMs / 1000 + 0.0001})`;
  const bytes = await run('ffmpeg', ['-nostdin', '-v', 'error', '-protocol_whitelist', 'pipe', '-threads', '2',
    '-f', 'mov', '-copyts', '-i', 'pipe:0', '-an', '-vf', filter, '-frames:v', '1', '-threads', '1',
    '-q:v', '2', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1'], segment, signal, 4 * 1024 * 1024);
  const dimensions = jpegDimensions(bytes);
  if (!dimensions || dimensions.width !== format.width || dimensions.height !== format.height) return;
  return { timestampMs, ...dimensions, sourceWidth: format.width, sourceHeight: format.height,
    mimeType: 'image/jpeg', imageBase64: bytes.toString('base64') };
}

async function extract(request, slot, session, signal, started, playbackReuse, usage) {
  if (session.failure) {
    diagnostic({ stage: 'player', proxySlot: slot, elapsedMs: Date.now() - started, error: { code: session.failure } });
    throw new Error('Player unavailable');
  }
  const formats = session.formats.map(buildSabrFormat);
  const format = formats.filter(f => f.height >= 720 && f.width <= request.maxWidth && f.mimeType?.includes('avc1'))
    .sort((a, b) => b.width - a.width || b.bitrate - a.bitrate)[0];
  if (!format || !session.token) throw new Error('No attested HD format');
  diagnostic({ stage: 'media_source', playbackReuse, elapsedMs: Date.now() - started, formatId: format.itag,
    width: format.width, height: format.height, proxySlot: slot });
  const transport = createFrameTransport(process.env, { preferSlot: slot });
  let imageBytes = frames.reduce((total, frame) => total + Buffer.byteLength(frame.imageBase64, 'base64'), 0);
  const fetchFunction = async (url, options) => {
    const target = new URL(url);
    if (target.protocol !== 'https:' || !target.hostname.endsWith('.googlevideo.com') || target.port ||
        target.username || target.password || ++usage.calls > 30) throw new Error('Invalid media request');
    const headers = new Headers(options.headers);
    headers.set('origin', 'https://m.youtube.com');
    headers.set('referer', 'https://m.youtube.com/');
    if (session.userAgent) headers.set('user-agent', session.userAgent);
    const response = await transport.fetch(target, { ...options, headers, redirect: 'manual',
      signal: AbortSignal.any([signal, options.signal, AbortSignal.timeout(8000)]) });
    diagnostic({ stage: 'media_http', formatId: format.itag, status: response.status, proxySlot: slot });
    const body = response.body?.pipeThrough(new TransformStream({ transform(chunk, controller) {
      usage.bytes += chunk.byteLength;
      if (usage.bytes > 40 * 1024 * 1024) throw new Error('Media byte limit');
      controller.enqueue(chunk);
    } }));
    return new Response(body, { status: response.status, headers: response.headers });
  };
  try {
    // Nearby frames share a seek; distant timestamps each start at their own segment.
    const remaining = request.timestampsMs.filter(time => !frames.some(frame => frame.timestampMs === time));
    let token = session.token;
    while (remaining.length) {
      const first = remaining.shift();
      const group = [first];
      while (remaining.length && remaining[0] - first <= 15000) group.push(remaining.shift());
      const stream = new SabrStream({ serverAbrStreamingUrl: session.url, videoPlaybackUstreamerConfig: session.config,
        clientInfo: { clientName: 2, clientVersion: session.clientVersion }, videoId: request.videoId, formats,
        poToken: token, fetchFunction });
      let rejected = false;
      stream.on('error', () => {});
      stream.on('streamProtectionStatusUpdate', status => {
        if (status.status === 3) {
          rejected = true;
          diagnostic({ stage: 'player', proxySlot: slot, error: { code: 'AUTH_REQUIRED' } });
          void stream.abort().catch(() => {});
        }
      });
      const abort = () => { void stream.abort().catch(() => {}); };
      signal.throwIfAborted();
      signal.addEventListener('abort', abort, { once: true });
      try {
        const reader = stream.start({ videoFormat: format.itag, audioPreferences: { preferredAudioCodec: 'aac' }, enabledTrackTypes: 2, startTimeMs: first,
          maxRetries: 0, stallDetectionMs: 5000, isPostLiveDvr: false }).videoStream.getReader();
        let init;
        for (let i = 0; group.length && i < 9; i++) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!init) { init = Buffer.from(value); continue; }
          const segment = Buffer.concat([init, value]);
          const times = await frameTimes(segment, signal);
          for (const time of [...group]) {
            const index = times.findLastIndex(pts => pts <= time + 0.5);
            if (index < 0 || (index === times.length - 1 && time - times[index] >= 1000 / (format.fps || 30))) continue;
            const frame = await decode(segment, times[index], time, format, signal);
            if (!frame) continue;
            imageBytes += Buffer.byteLength(frame.imageBase64, 'base64');
            if (imageBytes > MAX_IMAGE_BYTES) throw new Error('Image byte limit');
            frames.push(frame);
            group.splice(group.indexOf(time), 1);
            diagnostic({ stage: 'media_decode', formatId: format.itag, width: frame.width, height: frame.height,
              timestampMs: time, elapsedMs: Date.now() - started });
          }
        }
      } catch (error) {
        if (!rejected) throw error;
      } finally {
        signal.removeEventListener('abort', abort);
        abort();
      }
      if (rejected) {
        if (!session.videoToken || token === session.videoToken) throw new Error('Playback proof rejected');
        token = session.videoToken;
        remaining.unshift(...group);
      }
    }
    session.token = token;
  } finally { await transport.close({ force: true }); }
}

let result;
try {
  const request = parseFrameRequest(JSON.parse(await readFile(join(directory, 'request.json'), 'utf8')));
  const routing = JSON.parse(await readFile(join(directory, 'routing.json'), 'utf8'));
  const slots = parseProxyOrder(routing.proxyOrder.join(','));
  const proxy = slots?.length === 1 && proxyConnections(process.env)[slots[0]];
  if (!proxy) throw new Error('Missing proxy');
  const signal = AbortSignal.timeout(request.extractionTimeoutMs ?? 45000);
  const started = Date.now();
  let seed = {};
  if (process.send) {
    const reply = once(process, 'message', { signal });
    process.send('lookup');
    [seed] = await reply;
  }
  const route = fixedPlaybackRoute(proxy);
  let mode = playbackReuseMode(seed, route);
  diagnostic({ stage: 'proxy', egress: 'proxy', proxySlot: slots[0], playbackReuse: mode });
  const usage = { bytes: 0, calls: 0 };
  for (;;) {
    const createdAt = Date.now();
    try {
      const proof = mode === 'fresh' && route ? currentProxyExit(slots[0], proxy, signal).catch(() => undefined) : undefined;
      const session = mode === 'session' ? seed.session.data :
        await resolvePlayback(request.videoId, proxy, signal, mode === 'config' ? seed.config.data : undefined, seed.reuseConfig && mode === 'fresh');
      const { mobileConfig, ...playback } = session;
      if (mode === 'config' && !session.failure && new URL(session.url).searchParams.get('ip') !== seed.config.exit) {
        throw new Error('Playback exit changed');
      }
      await extract(request, slots[0], playback, signal, started, mode, usage);
      if (frames.length < request.timestampsMs.length && mode !== 'fresh') throw new Error('Incomplete cached playback');
      if (process.send && route && frames.length === request.timestampsMs.length) {
        const verifiedExit = await proof;
        await new Promise(resolve => process.send({ type: 'save', playback, createdAt, mode, route, verifiedExit,
          mobileConfig: seed.reuseConfig && mode === 'fresh' ? mobileConfig : undefined }, resolve));
      }
      break;
    } catch {
      if (mode === 'fresh' || signal.aborted || usage.bytes >= 40 * 1024 * 1024 ||
          usage.calls >= 30 || Date.now() - started + 5000 >= (request.extractionTimeoutMs ?? 45000)) break;
      mode = 'fresh'; // Cached state was checked out destructively. Retry only missing timestamps.
    }
  }
  if (!frames.length) throw new Error('No HD frames');
  const failures = request.timestampsMs.filter(t => !frames.some(f => f.timestampMs === t)).map(timestampMs =>
    ({ timestampMs, code: 'MEDIA_UNAVAILABLE', message: 'HD playback unavailable.', retryable: true }));
  result = { value: { videoId: request.videoId, frames, failures, meta: {
    partial: failures.length > 0, warnings: [], fetchedAt: new Date().toISOString(), source: 'video2ctx',
  } } };
} catch {
  result = { error: { code: 'MEDIA_UNAVAILABLE', message: 'HD playback unavailable.', retryable: true } };
}
await writeFile(join(directory, 'result.json'), JSON.stringify(result));
// The SABR library can retain network timers after abort. This single-use child has finished.
process.exit(0);
