import { randomInt } from 'node:crypto';
import { ProxyAgent, fetch as undiciFetch } from 'undici';

// Match the Worker/processor pool contract. Select once per extraction job.
export function proxyConnections(environment) {
  const pool = environment.OUTBOUND_PROXY_URLS?.trim();
  const legacy = environment.OUTBOUND_PROXY_URL?.trim();
  let urls;
  try {
    urls = pool ? JSON.parse(pool) : legacy ? [legacy] : [];
    if (!Array.isArray(urls) || urls.length > 4 || (pool && urls.length < 1)) throw new Error();
    const normalized = urls.map(value => {
      if (typeof value !== 'string' || !value.trim()) throw new Error();
      const url = new URL(value.trim());
      if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.hash) throw new Error();
      return url.href;
    });
    if (new Set(normalized).size !== normalized.length) throw new Error();
    return normalized;
  } catch {
    // Parsing and URL exceptions may contain credentials. Never propagate them.
    throw Object.assign(new Error('Outbound proxy configuration must contain one to four distinct HTTP(S) proxy URLs.'),
      { failureReason: 'invalid_proxy_configuration' });
  }
}

export function createFrameTransport(environment, {
  select = randomInt,
  excludeSlots = [],
  preferSlot,
  firstResponseTimeoutMs,
  createDispatcher = url => new ProxyAgent(url),
  fetch = undiciFetch,
  directFetch = globalThis.fetch,
  closeGraceMs = 1_000,
} = {}) {
  const urls = proxyConnections(environment);
  if (!urls.length) return { fetch: directFetch, close: async () => {}, proxyConfigured: false };
  const slots = urls.map((_, index) => index).filter(index => !excludeSlots.includes(index));
  if (!slots.length) throw new Error("No alternate proxy available.");
  const slot = slots.includes(preferSlot) ? preferSlot : slots[select(slots.length)];
  let failure;
  let proven = false;
  // One timer per route, started by its first request and cleared by any response, so a slower
  // concurrent request on a route that has already answered is never cut short.
  let routeGuard;
  let routeTimer;
  const dispatcher = createDispatcher(urls[slot]);
  return {
    // Metadata, player profiles and media byte ranges share this dispatcher.
    fetch: async (input, init) => {
      if (failure) throw failure;
      // Until the route answers once, a stalled request is a route failure, not a slow upstream.
      // Media hosts get their own first-response check in the range proxy.
      if (!proven && firstResponseTimeoutMs !== undefined && !routeGuard) {
        const created = new AbortController();
        routeGuard = created;
        routeTimer = setTimeout(() => created.abort(), firstResponseTimeoutMs);
      }
      const guard = proven ? undefined : routeGuard;
      const signal = guard ? (init?.signal ? AbortSignal.any([init.signal, guard.signal]) : guard.signal) : init?.signal;
      try {
        const response = await fetch(input, { ...init, signal, dispatcher });
        proven = true;
        clearTimeout(routeTimer);
        return response;
      } catch (error) {
        if (!init?.signal?.aborted) {
          if (guard?.signal.aborted) {
            failure ??= Object.assign(new Error('Outbound proxy route did not respond.'), {
              code: 'PROXY_TUNNEL_FAILED', failureReason: 'proxy_tunnel_failed', causeCode: 'ETIMEDOUT',
            });
            throw failure;
          }
          const status = tunnelStatus(error);
          if (status !== undefined) {
            failure = Object.assign(new Error('Outbound proxy tunnel failed.'), {
              code: 'PROXY_TUNNEL_FAILED', status, failureReason: 'proxy_tunnel_failed',
            });
            throw failure;
          }
        }
        throw error;
      }
    },
    get failure() { return failure; },
    // A stalled CONNECT can keep a graceful close pending until undici's own timeout,
    // which would hold the job past its budget. Give it a moment, then tear it down.
    // A route already known to have failed is torn down at once.
    close: async ({ force = false } = {}) => {
      clearTimeout(routeTimer);
      if (force) { await dispatcher.destroy().catch(() => {}); return; }
      let timer;
      const closed = dispatcher.close().then(() => true, () => true);
      const graceful = await Promise.race([closed, new Promise(resolve => { timer = setTimeout(resolve, closeGraceMs, false); })]);
      clearTimeout(timer);
      if (!graceful) await dispatcher.destroy().catch(() => {});
    },
    proxyConfigured: true,
    slot,
  };
}

// Undici nests CONNECT failures under fetch/abort errors. Keep only the status.
export function tunnelStatus(error) {
  const seen = new Set();
  for (let depth = 0; error && depth < 8 && !seen.has(error); depth++, error = error.cause) {
    seen.add(error);
    const match = /Proxy response \((\d{3})\) !== 200 when HTTP Tunneling/.exec(error.message ?? '');
    if (match) return Number(match[1]);
  }
}
