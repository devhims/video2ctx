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
