import { randomBytes } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';

import type { MediaCandidate } from './media';

const DEFAULT_PREFIX_CACHE_BYTES = 4 * 1024 * 1024;
const DEFAULT_TRANSFER_LIMIT_BYTES = 256 * 1024 * 1024;

export class TransferBudget {
  used = 0;

  constructor(readonly limit = DEFAULT_TRANSFER_LIMIT_BYTES) {}

  consume(bytes: number): void {
    this.used += bytes;
    if (this.used > this.limit) throw new Error('MEDIA_TRANSFER_LIMIT');
  }
}

interface ParsedRange {
  start: number;
  end?: number;
}

function parseRange(value: string | undefined): ParsedRange | undefined {
  const match = /^bytes=(\d+)-(\d*)$/.exec(value ?? '');
  if (!match) return undefined;
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : undefined;
  if (!Number.isSafeInteger(start) || start < 0 || (end !== undefined && end < start)) return undefined;
  return { start, end };
}

function responseHeaders(response: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
    const value = response.headers.get(name);
    if (value) headers[name] = value;
  }
  return headers;
}

async function write(res: ServerResponse, bytes: Uint8Array): Promise<boolean> {
  if (res.destroyed) return false;
  if (res.write(bytes)) return true;
  return await new Promise<boolean>((resolve) => {
    const drain = () => { cleanup(); resolve(true); };
    const close = () => { cleanup(); resolve(false); };
    const cleanup = () => {
      res.off('drain', drain);
      res.off('close', close);
    };
    res.once('drain', drain);
    res.once('close', close);
  });
}

export interface MediaRangeProxy {
  url: string;
  close(): Promise<void>;
}

export async function startMediaRangeProxy(
  candidate: MediaCandidate,
  fetchImpl: typeof fetch,
  budget: TransferBudget,
  prefixLimit = DEFAULT_PREFIX_CACHE_BYTES,
): Promise<MediaRangeProxy> {
  const token = randomBytes(18).toString('hex');
  let prefix = Buffer.alloc(0);
  let contentType = candidate.mimeType.split(';')[0] ?? 'application/octet-stream';
  let totalLength = candidate.contentLength;
  const controllers = new Set<AbortController>();

  const pipeUpstream = async (
    range: string | undefined,
    res: ServerResponse,
    writeHeaders: boolean,
    cachePrefix: boolean,
  ): Promise<void> => {
    const controller = new AbortController();
    controllers.add(controller);
    const onClose = () => controller.abort();
    res.once('close', onClose);
    try {
      const upstream = await fetchImpl(candidate.url, {
        headers: range ? { Range: range } : undefined,
        signal: controller.signal,
      });
      if (writeHeaders) res.writeHead(upstream.status, responseHeaders(upstream));
      if (!upstream.ok || !upstream.body) {
        if (!res.destroyed) res.end();
        return;
      }
      contentType = upstream.headers.get('content-type') ?? contentType;
      const contentRange = upstream.headers.get('content-range');
      const total = contentRange?.match(/\/(\d+)$/)?.[1];
      if (total) totalLength = Number(total);
      const reader = upstream.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done || res.destroyed) break;
          budget.consume(value.byteLength);
          if (cachePrefix && prefix.length < prefixLimit) {
            const remaining = prefixLimit - prefix.length;
            prefix = Buffer.concat([prefix, Buffer.from(value.subarray(0, remaining))]);
          }
          if (!await write(res, value)) break;
        }
      } finally {
        if (res.destroyed) await reader.cancel().catch(() => undefined);
      }
      if (!res.destroyed && !res.writableEnded) res.end();
    } catch (error) {
      if (error instanceof Error && error.message === 'MEDIA_TRANSFER_LIMIT') {
        res.destroy();
      } else if (!controller.signal.aborted) {
        if (!res.headersSent) res.writeHead(502);
        if (!res.destroyed) res.end();
      }
    } finally {
      res.off('close', onClose);
      controllers.delete(controller);
    }
  };

  const server = createServer(async (req, res) => {
    if (req.method !== 'GET' || req.url !== `/${token}`) {
      res.writeHead(404).end();
      return;
    }
    const rangeHeader = typeof req.headers.range === 'string' ? req.headers.range : undefined;
    const requested = parseRange(rangeHeader);
    if (requested?.start === 0 && prefix.length && totalLength) {
      const end = requested.end ?? totalLength - 1;
      const length = end + 1;
      res.writeHead(206, {
        'content-type': contentType,
        'accept-ranges': 'bytes',
        'content-range': `bytes 0-${end}/${totalLength}`,
        'content-length': String(length),
      });
      const cached = prefix.subarray(0, Math.min(prefix.length, length));
      if (!await write(res, cached) || cached.length >= length) {
        if (!res.destroyed && !res.writableEnded) res.end();
        return;
      }
      await pipeUpstream(`bytes=${cached.length}-${end}`, res, false, false);
      return;
    }
    await pipeUpstream(rangeHeader, res, true, requested?.start === 0);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Could not bind the media range proxy.');
  }
  return {
    url: `http://127.0.0.1:${address.port}/${token}`,
    close: async () => {
      for (const controller of controllers) controller.abort();
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
