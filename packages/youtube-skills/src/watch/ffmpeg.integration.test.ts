import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';

import { extractJpeg } from './ffmpeg';
import { startMediaRangeProxy, TransferBudget } from './range-proxy';

const describeFfmpeg = process.env.WATCH_FFMPEG_TEST === '1' ? describe : describe.skip;
const directories: string[] = [];
const servers: Server[] = [];

afterAll(async () => {
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  })));
});

describeFfmpeg('youtube-watch private FFmpeg range integration', () => {
  test('decodes a remote timestamp through the localhost proxy', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'watch-ffmpeg-test-'));
    directories.push(directory);
    const videoPath = join(directory, 'fixture.mp4');
    const generated = spawnSync(process.env.FFMPEG_PATH || 'ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=2',
      '-t', '4', '-c:v', 'mpeg4', '-movflags', '+faststart', '-y', videoPath,
    ], { encoding: 'utf8' });
    expect(generated.status, generated.stderr).toBe(0);
    const payload = await readFile(videoPath);
    const ranges: string[] = [];
    const server = createServer((req, res) => {
      const range = req.headers.range ?? `bytes=0-${payload.length - 1}`;
      ranges.push(range);
      const match = /^bytes=(\d+)-(\d*)$/.exec(range);
      const start = match ? Number(match[1]) : 0;
      const end = match?.[2] ? Number(match[2]) : payload.length - 1;
      const body = payload.subarray(start, Math.min(end + 1, payload.length));
      res.writeHead(req.headers.range ? 206 : 200, {
        'content-type': 'video/mp4',
        'content-length': String(body.length),
        'accept-ranges': 'bytes',
        ...(req.headers.range
          ? { 'content-range': `bytes ${start}-${start + body.length - 1}/${payload.length}` }
          : {}),
      });
      res.end(body);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as AddressInfo).port;
    const budget = new TransferBudget(32 * 1024 * 1024);
    const proxy = await startMediaRangeProxy({
      url: `http://127.0.0.1:${port}/fixture.mp4`,
      width: 640,
      height: 360,
      contentLength: payload.length,
      mimeType: 'video/mp4',
      progressive: true,
    }, fetch, budget);

    try {
      const frame = await extractJpeg(
        process.env.FFMPEG_PATH || 'ffmpeg', proxy.url, directory,
        'abcdefghijk', 2_000, 320, 640, 360,
      );
      expect(frame).toMatchObject({
        timestampMs: 2_000, width: 320, height: 180, sourceWidth: 640, sourceHeight: 360,
      });
      expect(ranges.some((range) => range.startsWith('bytes='))).toBe(true);
      expect(budget.used).toBeGreaterThan(0);
    } finally {
      await proxy.close();
    }
  }, 60_000);
});
