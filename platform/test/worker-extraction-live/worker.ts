// Isolated live verification entrypoint. Deploy with no production bindings.
import { createWorkerExtractionRunner, workerProxyUrls } from '../../src/lib/youtube-worker-extraction';
import { executeWorkerYouTubeOperation, type WorkerYouTubeOperation } from '../../src/lib/youtube-worker-runtime';
import { createWorkerProxyTransport } from '../../src/lib/youtube-worker-transport';
import type { ExtractionAttempt } from '../../src/lib/extraction-diagnostics';

const cases: Record<string, WorkerYouTubeOperation> = {
  transcript: { kind: 'transcript', id: 'dQw4w9WgXcQ', granularity: 'segment' },
  transcriptSecond: { kind: 'transcript', id: 'GmLcJVzkxPA', granularity: 'segment' },
  transcriptThird: { kind: 'transcript', id: 'S4tdkSVuxZA', granularity: 'segment' },
  translated: { kind: 'transcript', id: 'dQw4w9WgXcQ', lang: 'fr', granularity: 'segment' },
  words: { kind: 'transcript', id: 'dQw4w9WgXcQ', granularity: 'word' },
  tracks: { kind: 'caption-tracks', id: 'dQw4w9WgXcQ' },
  video: { kind: 'video', id: 'dQw4w9WgXcQ' },
  signals: { kind: 'video-signals', id: 'dQw4w9WgXcQ' },
  search: { kind: 'search', query: 'Rick Astley Never Gonna Give You Up' },
  browse: { kind: 'browse', options: { browseId: 'UCuAXFkgsw1L7xaCfnd5JJOw' } },
  channel: { kind: 'channel', id: 'UCuAXFkgsw1L7xaCfnd5JJOw' },
  channelVideos: { kind: 'channel-videos', id: 'UCuAXFkgsw1L7xaCfnd5JJOw' },
  channelPlaylists: { kind: 'channel-playlists', id: 'UCuAXFkgsw1L7xaCfnd5JJOw' },
  playlist: { kind: 'playlist', id: 'PLMC9KNkIncKtPzgY-5rmhvj7fax8fdxoj' },
  comments: { kind: 'comments', id: 'dQw4w9WgXcQ' },
  allComments: { kind: 'all-comments', id: 'dQw4w9WgXcQ', maxPages: 2 },
  endscreen: { kind: 'endscreen', id: 'dQw4w9WgXcQ' },
};
export default {
  async fetch(request: Request, env: Env & { TEST_TOKEN: string }): Promise<Response> {
    if (!env.TEST_TOKEN || request.headers.get('authorization') !== `Bearer ${env.TEST_TOKEN}`) return new Response('Unauthorized', { status: 401 });
    const url = new URL(request.url);
    const certificateHosts: Record<string, string> = { '/cert-expired': 'expired.badssl.com', '/cert-hostname': 'wrong.host.badssl.com' };
    if (certificateHosts[url.pathname]) {
      const proxy = workerProxyUrls(env)[0];
      if (!proxy) return Response.json({ ok: false, code: 'MISSING_PROXY' });
      const transport = createWorkerProxyTransport(proxy);
      try {
        await transport.fetch(`https://${certificateHosts[url.pathname]}/`);
        return Response.json({ ok: false, code: 'INVALID_CERT_ACCEPTED' });
      } catch (error) {
        const code = (error as { code?: string }).code;
        const expected = url.pathname === '/cert-expired' ? 'CERT_EXPIRED' : 'CERT_NAME_MISMATCH';
        return Response.json({ ok: code === expected, code });
      } finally { await transport.close(); }
    }
    const operation = cases[url.pathname.slice(1)];
    if (!operation) return new Response('Unknown test', { status: 404 });
    const forced = url.searchParams.has('proxy');
    const attempts: ExtractionAttempt[] = [];
    let proxyConnections = 0;
    const run = createWorkerExtractionRunner({ execute: executeWorkerYouTubeOperation,
      directFetch: forced ? async () => new Response('', { status: 429 }) : fetch,
      proxyTransport: proxy => { proxyConnections++; return createWorkerProxyTransport(proxy); },
    });
    const started = Date.now();
    try {
      const value = await run(env, operation, event => attempts.push(event));
      const data = value as unknown as Record<string, unknown>;
      const summary: Record<string, unknown> = {};
      for (const key of ['text', 'segments', 'tracks', 'videos', 'playlists', 'comments', 'results']) {
        const item = data[key];
        if (typeof item === 'string' || Array.isArray(item)) summary[key + 'Length'] = item.length;
      }
      summary.pagesFetched = data.pagesFetched;
      summary.granularity = data.granularity;
      summary.translatedTo = data.translatedTo;
      summary.partial = (data.meta as { partial?: boolean } | undefined)?.partial;
      return Response.json({ ok: true, elapsedMs: Date.now() - started, proxyConnections, attempts, summary });
    } catch (error) {
      const failure = error as { code?: string; message?: string };
      return Response.json({ ok: false, elapsedMs: Date.now() - started, proxyConnections, attempts, code: failure.code, message: failure.message }, { status: 502 });
    }
  },
};
