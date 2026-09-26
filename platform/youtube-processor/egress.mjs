// Pool order maps to the Worker's logical processor slots. Keep credentials private.
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
    throw new Error('Outbound proxy configuration must contain one to four distinct HTTP(S) proxy URLs.');
  }
}
