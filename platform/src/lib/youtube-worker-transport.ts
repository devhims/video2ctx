import { connect } from 'cloudflare:sockets';
import { Client } from 'tunnelfetch';

export interface YouTubeFetchTransport {
  fetch: typeof fetch;
  close(): Promise<void>;
}

/** A request-scoped pool. Never share sockets or credentials across invocations. */
export function createWorkerProxyTransport(proxy: string): YouTubeFetchTransport {
  const client = new Client({
    connect: (address, options) => connect(address, { ...options, allowHalfOpen: options?.allowHalfOpen ?? false }),
    proxy,
    forceTunnel: true,
    trust: { mode: 'system' },
    maxBodyBytes: 8 * 1024 * 1024,
    maxRedirects: 3,
    timeouts: { connectMs: 10_000, handshakeMs: 15_000, headersMs: 15_000, idleMs: 10_000, totalMs: 25_000 },
  });
  return {
    fetch: (input, init) => client.fetch(input, init),
    close: () => client.close(),
  };
}
