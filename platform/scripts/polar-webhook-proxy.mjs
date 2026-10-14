import http from 'node:http';
import { pathToFileURL } from 'node:url';

// Tunnel only the webhook, never the local dashboard, auth, or admin routes.
export function createPolarWebhookProxy({
  upstreamUrl = 'http://127.0.0.1:8787/api/auth/polar/webhooks',
  timeoutMs = 9000,
} = {}) {
  return http.createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/api/auth/polar/webhooks') {
      response.writeHead(404).end();
      return;
    }
    try {
      const chunks = [];
      let size = 0;
      let oversized = false;
      for await (const chunk of request) {
        if (oversized) continue;
        size += chunk.length;
        if (size > 1_048_576) {
          oversized = true;
          chunks.length = 0;
          response.writeHead(413, { connection: 'close' }).end();
          continue;
        }
        chunks.push(chunk);
      }
      if (oversized) return;
      const headers = Object.fromEntries(['content-type', 'webhook-id', 'webhook-timestamp', 'webhook-signature']
        .filter((key) => typeof request.headers[key] === 'string').map((key) => [key, request.headers[key]]));
      const upstream = await fetch(upstreamUrl, {
        method: 'POST', headers, body: Buffer.concat(chunks), redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
      });
      // Keep the response uncommitted until the complete upstream body is available.
      const body = await upstream.text();
      if (response.destroyed) return;
      response.writeHead(upstream.status, { 'content-type': 'application/json' });
      response.end(body);
      console.log(JSON.stringify({ event: 'polar_sandbox_delivery', status: upstream.status }));
    } catch {
      if (response.headersSent || response.destroyed) {
        response.destroy();
        return;
      }
      response.writeHead(502).end();
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createPolarWebhookProxy().listen(8788, '127.0.0.1', () => {
    console.log('Sandbox webhook proxy listening on 127.0.0.1:8788');
  });
}
