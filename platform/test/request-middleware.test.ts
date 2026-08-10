vi.mock('cloudflare:workers', () => ({ WorkflowEntrypoint: class {}, DurableObject: class {} }));

import { Hono } from 'hono';
import type { App } from '../src/types';
import { app } from '../src/index';
import { requestContext } from '../src/middlewares/request-context';

describe('request middleware', () => {
  test('allows app-origin API-key preflights and exposes credit headers', async () => {
    const response = await app.request('/v1/search', {
      method: 'OPTIONS',
      headers: {
        origin: 'https://app.example.com',
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization,x-api-key',
      },
    }, { APP_ORIGIN: 'https://app.example.com' } as unknown as Env);

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://app.example.com');
    expect(response.headers.get('access-control-allow-headers')).toContain('X-API-Key');
    expect(response.headers.get('access-control-allow-headers')).toContain('Authorization');
    expect(response.headers.get('access-control-expose-headers')).toContain('X-Credits-Charged');
  });

  test('does not allow an untrusted browser origin', async () => {
    const response = await app.request('/v1/search', {
      method: 'OPTIONS',
      headers: {
        origin: 'https://evil.example.com',
        'access-control-request-method': 'GET',
      },
    }, { APP_ORIGIN: 'https://app.example.com' } as unknown as Env);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  test('keeps public callbacks public while protecting known route groups', async () => {
    const env = { APP_ORIGIN: 'https://app.example.com' } as unknown as Env;
    const callback = await app.request('/v1/oauth/youtube/callback', {
      headers: { cookie: 'better-auth.session_token=expired-cookie' },
    }, env);
    expect(callback.status).toBe(422);
    await expect(callback.json()).resolves.toMatchObject({ error: { code: 'OAUTH_CALLBACK_INVALID' } });

    expect((await app.request('/v1/search?q=test', {}, env)).status).toBe(401);
    expect((await app.request('/v1/projects', {}, env)).status).toBe(401);
    expect((await app.request('/v1/not-a-route', {}, env)).status).toBe(404);
  });

  test('logs identifiers without logging API-key or cookie secrets', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const middlewareApp = new Hono<App>();
    middlewareApp.use('*', requestContext);
    middlewareApp.use('*', async (c, next) => {
      const user = { id: 'user-1', email: 'secret@example.com', name: 'Secret User' };
      c.set('principal', { user, method: 'api-key', apiKeyId: 'key-1', permissions: { data: ['read'] } });
      await next();
    });
    middlewareApp.get('/', (c) => c.json({ ok: true }));

    const response = await middlewareApp.request('/', {
      headers: {
        authorization: 'Bearer aty_bearer-secret',
        'x-api-key': 'aty_super-secret',
        cookie: 'better-auth.session_token=secret-cookie',
      },
    }, { ENVIRONMENT: 'production' } as unknown as Env);
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
    expect(response.headers.get('Strict-Transport-Security')).toContain('max-age=31536000');
    const output = JSON.stringify(log.mock.calls);
    expect(output).toContain('key-1');
    expect(output).not.toContain('aty_super-secret');
    expect(output).not.toContain('aty_bearer-secret');
    expect(output).not.toContain('secret-cookie');
    expect(output).not.toContain('secret@example.com');
    log.mockRestore();
  });
});
