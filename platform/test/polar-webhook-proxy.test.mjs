import http from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, test } from 'vitest';
import { createPolarWebhookProxy } from '../scripts/polar-webhook-proxy.mjs';

const servers = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  })));
});

async function listen(server) {
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

async function deliver(origin) {
  return fetch(`${origin}/api/auth/polar/webhooks`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    signal: AbortSignal.timeout(3000),
  });
}

describe('local Polar webhook proxy upstream failures', () => {
  for (const failure of ['aborted body', 'body timeout']) {
    test(`returns 502 after an upstream ${failure} and serves the next delivery`, async () => {
      let fail = true;
      let abortedByUpstream = false;
      const upstream = await listen(http.createServer((request, response) => {
        request.resume();
        response.writeHead(200, { 'content-type': 'application/json' });
        if (!fail) {
          response.end('{"received":true}');
          return;
        }
        // Flush successful headers, then fail while the proxy is consuming the body.
        response.write('{"received":');
        if (failure === 'aborted body') setTimeout(() => {
          abortedByUpstream = true;
          response.destroy();
        }, 25);
      }));
      const proxy = await listen(createPolarWebhookProxy({
        upstreamUrl: `${upstream}/api/auth/polar/webhooks`, timeoutMs: 750,
      }));

      const failed = await deliver(proxy);
      expect(failed.status).toBe(502);
      expect(abortedByUpstream).toBe(failure === 'aborted body');
      await failed.text();
      fail = false;
      const retry = await deliver(proxy);
      expect(retry.status).toBe(200);
      expect(await retry.json()).toEqual({ received: true });
    });
  }
});


test('delivers a complete 413 for an unfinished oversized chunked upload', async () => {
  let forwarded = false;
  const upstream = await listen(http.createServer((_request, response) => {
    forwarded = true;
    response.end('{}');
  }));
  const proxy = await listen(createPolarWebhookProxy({ upstreamUrl: upstream }));
  const result = await new Promise((resolve, reject) => {
    const request = http.request(`${proxy}/api/auth/polar/webhooks`, { method: 'POST' }, (response) => {
      response.resume();
      response.on('end', () => {
        resolve({ status: response.statusCode, connection: response.headers.connection, complete: response.complete });
        request.end();
      });
      response.on('error', reject);
    });
    request.on('error', reject);
    request.setTimeout(3000, () => request.destroy(new Error('Missing oversized response')));
    // Leave the chunked request open, as a slow or malicious uploader might.
    request.write(Buffer.alloc(1_048_577));
  });
  expect(result).toEqual({ status: 413, connection: 'close', complete: true });
  expect(forwarded).toBe(false);
  const next = await fetch(`${proxy}/dashboard`);
  expect(next.status).toBe(404);
});
