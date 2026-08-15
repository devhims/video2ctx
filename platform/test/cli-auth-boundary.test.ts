import { Hono } from 'hono';
import type { App } from '../src/types';
import { jsonError } from '../src/lib/http';
import { restrictCliSessionAuthRoutes } from '../src/middlewares/authentication';

const app = new Hono<App>();
app.use('*', async (c, next) => {
  c.set('requestId', 'request-1');
  await next();
});
app.use('/api/auth/*', restrictCliSessionAuthRoutes);
app.all('/api/auth/*', (c) => c.json({ allowed: c.req.path }));
app.onError((error, c) => jsonError(c, error));

describe('CLI session Better Auth boundary', () => {
  test.each(['/api/auth/get-session', '/api/auth/sign-out'])(
    'allows the CLI session lifecycle route %s',
    async (path) => {
      const response = await app.request(path, {
        method: path.endsWith('sign-out') ? 'POST' : 'GET',
        headers: { authorization: 'Bearer cli-session-token' },
      });
      expect(response.status).toBe(200);
    },
  );

  test.each(['/api/auth/api-key/create', '/api/auth/api-key/list', '/api/auth/device/approve'])(
    'blocks CLI bearer sessions from browser-only Better Auth route %s',
    async (path) => {
      const response = await app.request(path, {
        method: 'POST',
        headers: { authorization: 'Bearer cli-session-token' },
      });
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({ error: { code: 'SESSION_REQUIRED' } });
    },
  );

  test('does not interfere with browser cookies or API-key credentials', async () => {
    const browser = await app.request('/api/auth/api-key/list', {
      headers: { cookie: 'better-auth.session_token=browser-session' },
    });
    expect(browser.status).toBe(200);

    const apiKey = await app.request('/api/auth/api-key/list', {
      headers: { authorization: 'Bearer aty_key' },
    });
    expect(apiKey.status).toBe(200);
  });
});
