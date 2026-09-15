import { randomUUID } from 'node:crypto';
import { errorDetails, logDiagnostic } from './diagnostics.mjs';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { parseFrameRequest } from './contract.mjs';
import { runFrameJob } from './runtime.mjs';

export function createFrameApp(run = runFrameJob, { log = logDiagnostic } = {}) {
  const app = new Hono();
  let active = false;
  app.get('/health', c => c.json({ status: 'ok', active }));
  app.use('/frames', bodyLimit({ maxSize: 4096 }));
  app.post('/frames', async c => {
    let request;
    try { request = parseFrameRequest(await c.req.json()); }
    catch (error) { return c.json({ error: { code: 'INVALID_INPUT', message: error.message, retryable: false } }, 422); }
    if (active) {
      c.header('Retry-After', '1');
      return c.json({ error: { code: 'PROCESSOR_BUSY', message: 'The frame processor is busy.', retryable: true } }, 503);
    }
    const suppliedId = c.req.header('x-extraction-id');
    const extractionId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(suppliedId ?? '') ? suppliedId : randomUUID();
    c.header('x-extraction-id', extractionId);
    const startedAt = Date.now();
    active = true;
    try {
      return c.json({ value: await run(request, { signal: c.req.raw.signal, extractionId, log }) });
    } catch (error) {
      const code = typeof error.code === 'string' ? error.code : 'FRAME_EXTRACTION_FAILED';
      const status = code === 'INVALID_INPUT' ? 422 : code === 'NOT_FOUND' ? 404 : code === 'RATE_LIMITED' ? 429
        : code === 'FRAME_TIMEOUT' || code === 'FRAME_CANCELLED' ? 503 : 502;
      log({ event: 'youtube_frames_failure', extractionId, videoId: request.videoId,
        timestampsMs: request.timestampsMs, elapsedMs: Date.now() - startedAt, status, error: errorDetails(error) });
      return c.json({ error: { code, message: code === 'INVALID_INPUT' ? error.message : 'YouTube frame extraction failed.',
        retryable: error.retryable === true } }, status);
    } finally { active = false; }
  });
  return app;
}
