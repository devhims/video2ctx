import http from 'node:http';

// Tunnel only the webhook, never the local dashboard, auth, or admin routes.
const server = http.createServer(async (request, response) => {
  if (request.method !== 'POST' || request.url !== '/api/auth/polar/webhooks') {
    response.writeHead(404).end();
    return;
  }
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 1_048_576) { response.writeHead(413).end(); return; }
      chunks.push(chunk);
    }
    const headers = Object.fromEntries(['content-type', 'webhook-id', 'webhook-timestamp', 'webhook-signature']
      .filter((key) => typeof request.headers[key] === 'string').map((key) => [key, request.headers[key]]));
    const upstream = await fetch('http://127.0.0.1:8787/api/auth/polar/webhooks', {
      method: 'POST', headers, body: Buffer.concat(chunks), redirect: 'manual', signal: AbortSignal.timeout(9000),
    });
    response.writeHead(upstream.status, { 'content-type': 'application/json' });
    response.end(await upstream.text());
    console.log(JSON.stringify({ event: 'polar_sandbox_delivery', status: upstream.status }));
  } catch {
    response.writeHead(502).end();
  }
});
server.listen(8788, '127.0.0.1', () => console.log('Sandbox webhook proxy listening on 127.0.0.1:8788'));
