import { Hono } from 'hono';
import type { App, AuthPrincipal } from '../src/types';
import { jsonError } from '../src/lib/http';
import { dataRoutes } from '../src/routes/data/data.index';
import { openApiDocument } from '../src/openapi';

const principal: AuthPrincipal = {
  user: { id: 'user-1', name: 'User', email: 'user@example.com' },
  method: 'api-key', apiKeyId: 'test-key', permissions: { data: ['read'] },
};

describe('agent-only frame extraction', () => {
  test.each(['GET', 'POST'])('does not expose a %s data API route', async method => {
    const app = new Hono<App>();
    app.use('*', async (c, next) => { c.set('principal', principal); await next(); });
    app.route('/v1', dataRoutes);
    app.onError((error, c) => jsonError(c, error));
    const response = await app.request('/v1/providers/youtube/videos/abcdefghijk/frames', {
      method,
      ...(method === 'POST' ? {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ timestampsMs: [1000] }),
      } : {}),
    }, {} as Env);
    expect(response.status).toBe(404);
  });

  test('does not advertise a data API frame endpoint', () => {
    expect(Object.keys(openApiDocument.paths).filter(path => path.endsWith('/frames'))).toEqual([]);
    expect(JSON.stringify(openApiDocument)).not.toContain('getVideoFrames');
  });
});
