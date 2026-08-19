import { createServer, request as httpRequest, type Server } from 'node:http';
import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import { describe, expect, test, vi } from 'vitest';
import { YouTubeClientError } from 'all-things-youtube';
import { createRequestFetch, runSkillCli, type CliDependencies, type CliIo } from './cli';

function captureIo(): CliIo & { output: string[]; errors: string[] } {
  const output: string[] = [];
  const errors: string[] = [];
  return {
    output,
    errors,
    stdout: (value) => output.push(value),
    stderr: (value) => errors.push(value),
  };
}

function testDependencies(
  operation: keyof NonNullable<CliDependencies['operations']>,
  handler: (options: Record<string, unknown>) => Promise<unknown>,
): CliDependencies & { close: ReturnType<typeof vi.fn> } {
  const close = vi.fn(async () => {});
  return {
    close,
    operations: { [operation]: handler },
    createFetch: () => ({ fetch: vi.fn() as unknown as typeof fetch, close }),
  };
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  return (server.address() as AddressInfo).port;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

describe('youtube-ctx direct CLI', () => {
  test('maps search flags to the shared library operation and emits JSON', async () => {
    const io = captureIo();
    const search = vi.fn(async () => ({ query: 'agent skills', videos: [] }));
    const dependencies = testDependencies('search', search);

    const exitCode = await runSkillCli([
      'search', '--query', 'agent skills', '--type', 'video', '--captions-only',
      '--min-views', '1000', '--region', 'IN',
    ], io, {}, dependencies);

    expect(exitCode).toBe(0);
    expect(search).toHaveBeenCalledWith(expect.objectContaining({
      query: 'agent skills',
      type: 'video',
      captionsOnly: true,
      minViews: 1000,
      region: 'IN',
      fetch: expect.any(Function),
    }));
    expect(JSON.parse(io.output[0]!)).toEqual({ query: 'agent skills', videos: [] });
    expect(io.errors).toEqual([]);
    expect(dependencies.close).toHaveBeenCalledOnce();
  });

  test('emits a compact text transcript while keeping segment granularity upstream', async () => {
    const io = captureIo();
    const transcript = vi.fn(async () => ({
      videoId: 'abcdefghijk',
      track: { id: 'en', languageCode: 'en', name: 'English' },
      segments: [{
        startMs: 0,
        durationMs: 1000,
        endMs: 1000,
        text: 'Hello world',
        words: [{ text: 'Hello', startMs: 0, offsetMs: 0 }],
      }],
      granularity: 'segment',
      text: 'Hello world',
      meta: { provider: 'youtube', partial: false, warnings: [] },
    }));
    const dependencies = testDependencies('transcript', transcript);

    const exitCode = await runSkillCli([
      'transcript', '--video-id', 'abcdefghijk', '--format', 'text',
    ], io, {}, dependencies);

    expect(exitCode).toBe(0);
    expect(transcript).toHaveBeenCalledWith(expect.objectContaining({
      videoId: 'abcdefghijk',
      granularity: 'segment',
    }));
    expect(JSON.parse(io.output[0]!)).toEqual({
      videoId: 'abcdefghijk',
      track: { id: 'en', languageCode: 'en', name: 'English' },
      text: 'Hello world',
      meta: { provider: 'youtube', partial: false, warnings: [] },
    });
  });

  test('rejects conflicting transcript format and legacy granularity flags', async () => {
    const io = captureIo();
    const transcript = vi.fn(async () => ({}));
    const dependencies = testDependencies('transcript', transcript);

    const exitCode = await runSkillCli([
      'transcript', '--video-id', 'abcdefghijk', '--format', 'words',
      '--granularity', 'segment',
    ], io, {}, dependencies);

    expect(exitCode).toBe(2);
    expect(transcript).not.toHaveBeenCalled();
    expect(JSON.parse(io.errors[0]!)).toMatchObject({
      error: { code: 'INVALID_INPUT', message: expect.stringContaining('cannot be combined') },
    });
  });

  test('enforces bounded all-comments options before making a request', async () => {
    const io = captureIo();
    const comments = vi.fn(async () => ({}));
    const dependencies = testDependencies('comments', comments);

    const exitCode = await runSkillCli([
      'comments', '--video-id', 'abcdefghijk', '--max-pages', '5',
    ], io, {}, dependencies);

    expect(exitCode).toBe(2);
    expect(comments).not.toHaveBeenCalled();
    expect(JSON.parse(io.errors[0]!)).toMatchObject({
      error: { code: 'INVALID_INPUT', retryable: false },
    });
    expect(dependencies.close).toHaveBeenCalledOnce();
  });

  test('requires an explicit page budget for all comments', async () => {
    const io = captureIo();
    const comments = vi.fn(async () => ({}));
    const dependencies = testDependencies('comments', comments);

    const exitCode = await runSkillCli([
      'comments', '--video-id', 'abcdefghijk', '--all',
    ], io, {}, dependencies);

    expect(exitCode).toBe(2);
    expect(comments).not.toHaveBeenCalled();
    expect(JSON.parse(io.errors[0]!)).toMatchObject({
      error: { code: 'INVALID_INPUT', message: expect.stringContaining('--max-pages') },
    });
  });

  test('serializes classified library failures without a stack trace', async () => {
    const io = captureIo();
    const dependencies = testDependencies('details', async () => {
      throw new YouTubeClientError('RATE_LIMITED', 'YouTube rate limited the request.', {
        status: 429,
        retryable: true,
      });
    });

    const exitCode = await runSkillCli(
      ['details', '--video-id', 'abcdefghijk'], io, {}, dependencies,
    );

    expect(exitCode).toBe(1);
    expect(io.output).toEqual([]);
    expect(JSON.parse(io.errors[0]!)).toEqual({
      error: {
        code: 'RATE_LIMITED',
        message: 'YouTube rate limited the request.',
        status: 429,
        retryable: true,
      },
    });
    expect(io.errors[0]).not.toContain('stack');
  });

  test('passes an explicit proxy to the fetch factory and closes it', async () => {
    const io = captureIo();
    const handler = vi.fn(async () => []);
    const close = vi.fn(async () => {});
    const createFetch = vi.fn(() => ({
      fetch: vi.fn() as unknown as typeof fetch,
      close,
    }));

    const exitCode = await runSkillCli(
      ['endscreen', '--video-id', 'abcdefghijk', '--proxy', 'http://proxy.test:8080'],
      io,
      {},
      { operations: { endscreen: handler }, createFetch },
    );

    expect(exitCode).toBe(0);
    expect(createFetch).toHaveBeenCalledWith('http://proxy.test:8080');
    expect(close).toHaveBeenCalledOnce();
  });

  test('routes fetch traffic through an HTTP proxy', async () => {
    const target = createServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end('{"proxied":true}');
    });
    const targetPort = await listen(target);
    let proxyConnections = 0;
    const proxy = createServer((request, response) => {
      proxyConnections += 1;
      const upstream = httpRequest(request.url!, {
        method: request.method,
        headers: request.headers,
      }, (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      });
      request.pipe(upstream);
    });
    proxy.on('connect', (request, clientSocket, head) => {
      proxyConnections += 1;
      const [hostname, port] = request.url!.split(':');
      const upstreamSocket = connect(Number(port), hostname, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length > 0) upstreamSocket.write(head);
        upstreamSocket.pipe(clientSocket);
        clientSocket.pipe(upstreamSocket);
      });
    });
    const proxyPort = await listen(proxy);
    const requestFetch = createRequestFetch(`http://127.0.0.1:${proxyPort}`);

    try {
      const response = await requestFetch.fetch(`http://127.0.0.1:${targetPort}`);
      await expect(response.json()).resolves.toEqual({ proxied: true });
      expect(proxyConnections).toBeGreaterThan(0);
    } finally {
      await requestFetch.close();
      await closeServer(proxy);
      await closeServer(target);
    }
  });

  test('prints authoritative command help without constructing a client', async () => {
    const io = captureIo();
    const createFetch = vi.fn();

    const exitCode = await runSkillCli(['--help'], io, {}, { createFetch });

    expect(exitCode).toBe(0);
    expect(io.output.join('')).toContain('youtube-ctx direct');
    expect(io.output.join('')).toContain('search');
    expect(io.output.join('')).toContain('--proxy <url>');
    expect(io.output.join('')).toContain('--format text|segments|words');
    expect(createFetch).not.toHaveBeenCalled();
  });
});
