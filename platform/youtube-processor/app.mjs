import { Hono } from 'hono';

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

    try {
      return c.json({ value: await runtime.run(operation) });
    } catch (error) {
      const normalized = normalizeProcessorError(error);
      console.error(JSON.stringify({
        event: 'youtube_processor_failure',
        operation: operation.kind,
        code: normalized.error.code,
        retryable: normalized.error.retryable,
      }));
      return c.json({ error: normalized.error }, normalized.responseStatus);
    }
  });

  app.all('/health', (c) => c.json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET.' } }, 405));
  app.all('/operations', (c) => c.json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Use POST.' } }, 405));
  app.notFound((c) => c.json({ error: { code: 'NOT_FOUND', message: 'Route not found.' } }, 404));

  return app;
}
