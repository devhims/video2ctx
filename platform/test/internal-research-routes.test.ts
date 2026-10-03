import { Hono } from 'hono';
import type { App, AuthPrincipal } from '../src/types';
import { jsonError } from '../src/lib/http';
import { dataRoutes } from '../src/routes/data/data.index';

function researchApp(method?: AuthPrincipal['method']) {
  const app = new Hono<App>();
  app.use('*', async (c, next) => {
    c.set('requestId', 'research-boundary-test');
    const user = { id: 'user-1', email: 'user@example.com', name: 'User' };
    c.set('principal', method ? {
      user, method, permissions: { data: ['read'], account: ['access'] },
    } : null);
    await next();
  });
  app.route('/v1', dataRoutes);
  app.onError((error, c) => jsonError(c, error));
  return app;
}

describe.each(['answers', 'comparisons', 'reports'])('internal research: %s', (operation) => {
  // Invalid JSON proves credential checks run before parsing, billing or retrieval.
  const request = { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' };

  test.each(['api-key', 'cli-session'] as const)('rejects %s credentials with data permission', async (method) => {
    const response = await researchApp(method).request(`/v1/projects/project-1/${operation}`, request);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'SESSION_REQUIRED' } });
  });

  test('requires authentication', async () => {
    const response = await researchApp().request(`/v1/projects/project-1/${operation}`, request);
    expect(response.status).toBe(401);
  });

  test('denies an unrecognized authentication method by default', async () => {
    const response = await researchApp('future-credential' as AuthPrincipal['method'])
      .request(`/v1/projects/project-1/${operation}`, request);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'SESSION_REQUIRED' } });
  });

  test.each(['session', 'demo'] as const)('retains %s access to the handler', async (method) => {
    const response = await researchApp(method).request(`/v1/projects/project-1/${operation}`, request);
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'INVALID_JSON' } });
  });
});
