import type { MiddlewareHandler } from 'hono';
import type { App, AuthPrincipal } from '../types';

/** Establishes safe request metadata and emits the final structured access log. */
export const requestContext: MiddlewareHandler<App> = async (c, next) => {
  const startedAt = Date.now();
  if (c.req.method === 'POST' && c.req.path === '/v1/agent') {
    c.set('requestStartedAt', startedAt);
    c.set('agentAdmissionTimings', []);
  }
  const requestId = c.req.header('cf-ray') ?? crypto.randomUUID();
  c.set('requestId', requestId);
  c.header('X-Request-Id', requestId);
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (String(c.env.ENVIRONMENT) === 'production') {
    c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  try {
    await next();
  } finally {
    const admissionTimings = c.get('agentAdmissionTimings');
    if (admissionTimings?.length) {
      c.header('Server-Timing', admissionTimings.map(({ stage, durationMs }) => `${stage};dur=${durationMs}`).join(', '));
    }
    const principal = c.get('principal') as AuthPrincipal | null | undefined;
    console.log({
      event: 'http_request',
      requestId,
      method: c.req.method,
      route: c.req.path,
      status: c.res.status,
      durationMs: Date.now() - startedAt,
      ...(admissionTimings ? { admissionTimings } : {}),
      authMethod: principal?.method ?? 'anonymous',
      apiKeyId: principal?.apiKeyId,
    });
  }
};
