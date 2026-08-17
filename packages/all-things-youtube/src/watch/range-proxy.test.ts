import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, test } from 'vitest';

import { startMediaRangeProxy, TransferBudget } from './range-proxy';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  })));
});

async function upstream(payload: Buffer): Promise<{ url: string; ranges: Array<string | undefined> }> {
  const ranges: Array<string | undefined> = [];
  const server = createServer((req, res) => {
    const range = req.headers.range;
    ranges.push(range);
    const match = /^bytes=(\d+)-(\d*)$/.exec(range ?? '');
    const start = match ? Number(match[1]) : 0;
    const end = match?.[2] ? Number(match[2]) : payload.length - 1;
    const body = payload.subarray(start, Math.min(end + 1, payload.length));
    res.writeHead(range ? 206 : 200, {
      'content-type': 'video/mp4',
      'accept-ranges': 'bytes',
      'content-length': String(body.length),
      ...(range ? { 'content-range': `bytes ${start}-${start + body.length - 1}/${payload.length}` } : {}),
    });
    res.end(body);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}/media`, ranges };
}

describe('media range proxy', () => {
  test('replays a cached stream prefix without another upstream request', async () => {
    const source = await upstream(Buffer.from('abcdefghijklmnopqrstuvwxyz'));
    const budget = new TransferBudget(1_024);
    const proxy = await startMediaRangeProxy({
      url: source.url,
      width: 640,
      height: 360,
      contentLength: 26,
      mimeType: 'video/mp4',
      progressive: true,
    }, fetch, budget, 16);

    try {
      const first = await fetch(proxy.url, { headers: { Range: 'bytes=0-9' } });
      expect(await first.text()).toBe('abcdefghij');
      const second = await fetch(proxy.url, { headers: { Range: 'bytes=0-9' } });
      expect(await second.text()).toBe('abcdefghij');
      expect(source.ranges).toEqual(['bytes=0-9']);
      expect(budget.used).toBe(10);
    } finally {
      await proxy.close();
    }
  });
});
