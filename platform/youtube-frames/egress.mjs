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
  createDispatcher = url => new ProxyAgent(url),
  fetch = undiciFetch,
  directFetch = globalThis.fetch,
} = {}) {
  const urls = proxyConnections(environment);
  if (!urls.length) return { fetch: directFetch, close: async () => {}, proxyConfigured: false };
  const slot = select(urls.length);
  const dispatcher = createDispatcher(urls[slot]);
  return {
    // Metadata, player profiles and media byte ranges share this dispatcher.
    fetch: (input, init) => fetch(input, { ...init, dispatcher }),
    close: () => dispatcher.close(),
    proxyConfigured: true,
    slot,
  };
}
