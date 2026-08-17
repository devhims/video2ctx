import { Hono } from 'hono';
import type { App, AuthPrincipal } from '../src/types';
import { jsonError } from '../src/lib/http';
import { sessionRoutes } from '../src/routes/session/session.index';

function accountApp(principal: AuthPrincipal): Hono<App> {
  const app = new Hono<App>();
  app.use('*', async (c, next) => {
    c.set('requestId', 'request-1');
    c.set('principal', principal);
    c.set('user', principal.user);
    await next();
  });
  app.route('/', sessionRoutes);
  app.onError((error, c) => jsonError(c, error));
  return app;
}

const cliPrincipal: AuthPrincipal = {
  user: { id: 'user-1', email: 'user@example.com', name: 'User' },
  method: 'cli-session',
  permissions: { data: ['read'], account: ['access'] },
};

describe('account route authentication boundaries', () => {
  test('returns identity details to an account-scoped CLI session', async () => {
    const response = await accountApp(cliPrincipal).request('/account');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      user: cliPrincipal.user,
      authentication: { method: 'cli-session' },
    });
  });

  test('keeps account deletion browser-session only', async () => {
    const response = await accountApp(cliPrincipal).request('/account', { method: 'DELETE' });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'SESSION_REQUIRED' } });
  });
});
