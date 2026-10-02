import { createFrameTransport, proxyConnections } from './egress.mjs';

// Time allowed for a proxy's first media response headers before switching proxies.
export const MEDIA_FIRST_RESPONSE_TIMEOUT_MS = 3_000;
// Time allowed for a proxy's first YouTube metadata or player response before switching proxies.
export const ROUTE_FIRST_RESPONSE_TIMEOUT_MS = 5_000;
// Residential exits fail independently, and a failed route costs a few seconds with the
// probes above, so a job may visit every configured proxy within its budget.
export const MAX_PROXY_ATTEMPTS = 4;

// A retry is a new extraction, so signed URLs are resolved on the new route.
// All attempts share one wall-clock budget. Never silently bypass the proxy.
export async function extractWithProxyFallback(request, {
  extractFrames, environment = process.env, onDiagnostic = () => {},
  transportFactory = createFrameTransport, now = Date.now, proxyOrder,
}) {
  const deadline = now() + (request.extractionTimeoutMs ?? 45_000);
  const pool = proxyConnections(environment);
  const maxAttempts = Math.max(1, Math.min(pool.length, MAX_PROXY_ATTEMPTS));
  const failedSlots = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Probe only while another proxy remains. The final route keeps the longer library and
    // FFmpeg timeouts, because failing it fast leaves nothing to switch to.
    const alternateAvailable = attempt < maxAttempts;
    // Follow the Worker's health order when it sent one; otherwise pick at random as before.
    const preferSlot = proxyOrder?.find(slot => slot < pool.length && !failedSlots.includes(slot));
    const transport = transportFactory(environment, {
      excludeSlots: [...failedSlots],
      ...(preferSlot !== undefined ? { preferSlot } : {}),
      ...(alternateAvailable ? { firstResponseTimeoutMs: ROUTE_FIRST_RESPONSE_TIMEOUT_MS } : {}),
    });
    let routeFailed = false;
    try {
      onDiagnostic({ stage: 'proxy', egress: transport.proxyConfigured ? 'proxy' : 'direct', proxySlot: transport.slot, attempt });
      return await extractFrames({
        ...request, preferResolution: false, timeBudgetMs: Math.max(1, deadline - now()),
        frameTimeoutMs: 10_000, fetch: transport.fetch, onDiagnostic,
        ...(alternateAvailable ? { mediaFirstResponseTimeoutMs: MEDIA_FIRST_RESPONSE_TIMEOUT_MS } : {}),
        retry: { policy: { maxAttempts: 2, attemptTimeoutMs: 8_000 } },
      });
    } catch (error) {
      const failure = transport.failure ?? error;
      if (failure?.code !== 'PROXY_TUNNEL_FAILED') throw error;
      routeFailed = true;
      onDiagnostic({ stage: 'proxy', proxySlot: transport.slot, attempt, error: failure });
      if (attempt === maxAttempts || deadline - now() < 5_000) throw failure;
      failedSlots.push(transport.slot);
    } finally {
      await transport.close({ force: routeFailed });
    }
  }
}
