import { createFrameTransport, proxyConnections } from './egress.mjs';

// A retry is a new extraction, so signed URLs are resolved on the new route.
// Both attempts share one wall-clock budget. Never silently bypass the proxy.
export async function extractWithProxyFallback(request, {
  extractFrames, environment = process.env, onDiagnostic = () => {},
  transportFactory = createFrameTransport, now = Date.now,
}) {
  const deadline = now() + (request.extractionTimeoutMs ?? 45_000);
  const pool = proxyConnections(environment);
  let excludeSlot;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const transport = transportFactory(environment, { excludeSlot });
    try {
      onDiagnostic({ stage: 'proxy', egress: transport.proxyConfigured ? 'proxy' : 'direct', proxySlot: transport.slot, attempt });
      const result = await extractFrames({
        ...request, preferResolution: false, timeBudgetMs: Math.max(1, deadline - now()),
        frameTimeoutMs: 10_000, fetch: transport.fetch, onDiagnostic,
        retry: { policy: { maxAttempts: 2, attemptTimeoutMs: 8_000 } },
      });
      return result;
    } catch (error) {
      const failure = transport.failure ?? error;
      if (failure?.code !== 'PROXY_TUNNEL_FAILED') throw error;
      onDiagnostic({ stage: 'proxy', proxySlot: transport.slot, attempt, error: failure });
      if (attempt === 2 || pool.length < 2 || deadline - now() < 5_000) throw failure;
      excludeSlot = transport.slot;
    } finally {
      await transport.close();
    }
  }
}
