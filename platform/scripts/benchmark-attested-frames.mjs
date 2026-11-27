// Start the frames image on loopback with its proxy configuration before running this smoke test.
import { performance } from 'node:perf_hooks';
import { jpegDimensions } from '../youtube-frames/dist/jpeg.mjs';

const port = Number(process.argv[2] ?? 8080);
const slot = Number(process.argv[3] ?? 0);
if (!Number.isInteger(port) || port < 1 || port > 65535 || !Number.isInteger(slot) || slot < 0 || slot > 3) {
  throw new Error('Usage: node benchmark-attested-frames.mjs [local port] [proxy slot 0-3]');
}
const cases = [
  { videoId: 'aqz-KE-bpKQ', timestampsMs: [300000] },
  { videoId: 'ZmLg3_Bv2vY', timestampsMs: [845000, 848000, 852000, 856000] },
];
if (process.argv[4] === '--reverse') cases.reverse();
for (const pass of [1, 2]) {
  for (const first of cases) {
    const input = pass === 1 ? first : { ...first, timestampsMs: [first.timestampsMs.at(-1) + 5000] };
    const start = performance.now();
    const response = await fetch(`http://127.0.0.1:${port}/frames/attested`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-proxy-order': String(slot) },
      body: JSON.stringify({ ...input, maxWidth: 1920, extractionTimeoutMs: 39000 }),
      signal: AbortSignal.timeout(45000),
    });
    const payload = await response.json();
    const elapsedMs = Math.round(performance.now() - start);
    const frames = payload.value?.frames ?? [];
    const verified = input.timestampsMs.every(time => {
      const frame = frames.find(f => f.timestampMs === time);
      if (!frame) return false;
      const size = jpegDimensions(Buffer.from(frame.imageBase64, 'base64'));
      return size?.width === 1920 && size.height === 1080;
    });
    const playback = payload.diagnostics?.events?.filter(e => e.stage === 'media_source' && e.playbackReuse)
      .map(e => ({ reuse: e.playbackReuse, setupMs: e.elapsedMs }));
    console.log(JSON.stringify({ pass, ...input, status: response.status, elapsedMs, playback, verified }));
    if (!verified) process.exitCode = 1;
  }
}
