import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';

export const OPERATION_KINDS = new Set([
  'search',
  'browse',
  'video',
  'video-signals',
  'channel',
  'channel-videos',
  'channel-playlists',
  'playlist',
  'comments',
  'all-comments',
  'caption-tracks',
  'transcript',
  'endscreen',
  'storyboard',
]);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function statusForCode(code) {
  if (code === 'INVALID_INPUT') return 422;
  if (code === 'NOT_FOUND') return 404;
  if (code === 'AUTH_REQUIRED') return 401;
  if (code === 'RATE_LIMITED') return 429;
  if (code === 'UNAVAILABLE') return 503;
  return 502;
}

export function normalizeProcessorError(error) {
  const code = typeof error?.code === 'string' ? error.code : 'UPSTREAM_ERROR';
  const message = error instanceof Error ? error.message : 'YouTube processing failed.';
  const upstreamStatus = Number.isInteger(error?.status) ? error.status : undefined;
  const retryable = typeof error?.retryable === 'boolean'
    ? error.retryable
    : code === 'UNAVAILABLE' || code === 'UPSTREAM_ERROR';

  return {
    responseStatus: statusForCode(code),
    error: { code, message, status: upstreamStatus, retryable },
  };
}

function concurrencyLimit(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 4;
  return Math.max(1, Math.min(32, Math.floor(parsed)));
}

export function createProcessorApp(runtime, options = {}) {
  const app = new Hono();
  const maxConcurrentOperations = concurrencyLimit(options.maxConcurrentOperations);
  let activeOperations = 0;

  app.get('/health', (c) => c.json({
    status: 'ok',
    runtime: 'hono-node-container',
    proxyConfigured: runtime.proxyConfigured === true,
    proxyConnections: runtime.proxyConnections ?? 0,
    capacity: { active: activeOperations, maximum: maxConcurrentOperations },
  }));

  app.use('/operations', async (c, next) => {
    if (activeOperations >= maxConcurrentOperations) {
      c.header('Retry-After', '1');
      return c.json({ error: {
        code: 'PROCESSOR_BUSY',
        message: 'This YouTube processor is at capacity.',
        retryable: true,
      } }, 503);
    }

    activeOperations += 1;
    try {
      await next();
    } finally {
      activeOperations -= 1;
    }
  });

  app.post('/operations', async (c) => {
    let operation;
    try {
      operation = await c.req.json();
    } catch {
      return c.json({ error: {
        code: 'INVALID_INPUT',
        message: 'The operation body must be valid JSON.',
        retryable: false,
      } }, 400);
    }

    if (!isRecord(operation) || typeof operation.kind !== 'string' || !OPERATION_KINDS.has(operation.kind)) {
      return c.json({ error: {
        code: 'INVALID_INPUT',
        message: 'The YouTube operation is not supported.',
        retryable: false,
      } }, 400);
    }

    const suppliedSlot = c.req.header('x-processor-egress-slot');
    if (suppliedSlot !== undefined && !/^[0-3]$/.test(suppliedSlot)) {
      return c.json({ error: { code: 'INVALID_INPUT', message: 'The processor egress slot is invalid.', retryable: false } }, 422);
    }
    const egressSlot = Number(suppliedSlot ?? '0');
    const diagnostics = { version: 1, events: [], droppedEvents: 0 };
    const suppliedId = c.req.header('x-extraction-id');
    const extractionId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(suppliedId ?? '') ? suppliedId : randomUUID();
    const onDiagnostic = event => {
      // Runtime events contain only scalar diagnostic fields. Bound the private envelope.
      if (JSON.stringify(event).length > 1024) { diagnostics.droppedEvents++; return; }
      if (diagnostics.events.length === 64) { diagnostics.events.splice(16, 1); diagnostics.droppedEvents++; }
      diagnostics.events.push(event);
    };
    const envelope = () => ['storyboard', 'transcript'].includes(operation.kind) ? { diagnostics } : {};
    const startedAt = performance.now();
    const cpuStarted = process.cpuUsage();
    const activeAtStart = activeOperations;

    try {
      return c.json({ value: await runtime.run(operation, { extractionId, egressSlot, onDiagnostic }), ...envelope() });
    } catch (error) {
      const normalized = normalizeProcessorError(error);
      console.error(JSON.stringify({
        event: 'youtube_processor_failure',
        extractionId,
        operation: operation.kind,
        egressSlot,
        code: normalized.error.code,
        retryable: normalized.error.retryable,
      }));
      return c.json({ error: normalized.error, ...envelope() }, normalized.responseStatus);
    } finally {
      const cpu = process.cpuUsage(cpuStarted);
      const memory = process.memoryUsage();
      // CPU and memory are process-wide: concurrent operations can contribute.
      // Log only measurements and the opaque correlation ID, never provider data.
      console.log(JSON.stringify({
        event: 'youtube_processor_timing', extractionId, operation: operation.kind,
        durationMs: Math.round(performance.now() - startedAt),
        processCpuMs: (cpu.user + cpu.system) / 1000,
        rssBytes: memory.rss, heapUsedBytes: memory.heapUsed,
        processUptimeSeconds: Math.round(process.uptime()), activeAtStart,
        proxyConfigured: runtime.proxyConfigured === true, egressSlot,
      }));
    }
  });

  app.all('/health', (c) => c.json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET.' } }, 405));
  app.all('/operations', (c) => c.json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Use POST.' } }, 405));
  app.notFound((c) => c.json({ error: { code: 'NOT_FOUND', message: 'Route not found.' } }, 404));

  return app;
}
