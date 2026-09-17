import { env, exports } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';

const worker = exports.default;
const baseUrl = 'http://auth.test';

describe('social sign-in on the Worker runtime', () => {
  for (const provider of ['google', 'github']) {
    test(`starts ${provider} OAuth with the configured callback and identity scopes`, async () => {
      const response = await request('/api/auth/sign-in/social', {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ provider, callbackURL: `${baseUrl}/dashboard`, errorCallbackURL: `${baseUrl}/login` }),
      });
      expect(response.status).toBe(200);
      const { url } = await response.json() as { url: string };
      const authorization = new URL(url);
      expect(authorization.hostname).toBe(provider === 'github' ? 'github.com' : 'accounts.google.com');
      expect(authorization.searchParams.get('client_id')).toBe(`test-${provider}-client`);
      expect(authorization.searchParams.get('redirect_uri')).toBe(`${baseUrl}/api/auth/callback/${provider}`);
      expect(authorization.searchParams.get('state')).toBeTruthy();
      const scopes = authorization.searchParams.get('scope')?.split(' ');
      expect(scopes).toEqual(expect.arrayContaining(provider === 'github' ? ['read:user', 'user:email'] : ['openid', 'email', 'profile']));
      expect(scopes).not.toContain('repo');
    });
  }
});

describe('Agent tester access with real D1 and browser sessions', () => {
  test('checks D1 changes on refresh without a new login and keeps admin jobs private', async () => {
    const browser = await createBrowserSession();
    const check = () => request('/v1/agent/access', { headers: { cookie: browser.cookie } });
    expect((await check()).status).toBe(403);

    // Direct console inserts can use mixed case and surrounding spaces.
    await env.DB.prepare('INSERT INTO agent_access_allowlist (email) VALUES (?)')
      .bind(`  ${browser.user.email.toUpperCase()}  `).run();
    const granted = await check();
    expect(granted.status).toBe(200);
    expect(granted.headers.get('Cache-Control')).toBe('no-store');
    expect(await granted.json()).toEqual({ enabled: true });
    expect((await request('/v1/admin/jobs', { headers: { cookie: browser.cookie } })).status).toBe(403);

    // Duplicate normalized emails are rejected by the migration's unique index.
    await expect(env.DB.prepare('INSERT INTO agent_access_allowlist (email) VALUES (?)')
      .bind(browser.user.email).run()).rejects.toThrow();

    // A cached login cannot override the current verified-email record.
    await env.DB.prepare('UPDATE user SET emailVerified = 0 WHERE id = ?').bind(browser.user.id).run();
    expect((await check()).status).toBe(403);
    await env.DB.prepare('UPDATE user SET emailVerified = 1 WHERE id = ?').bind(browser.user.id).run();
    expect((await check()).status).toBe(200);

    await env.DB.prepare('DELETE FROM agent_access_allowlist WHERE lower(trim(email)) = ?')
      .bind(browser.user.email.toLowerCase()).run();
    expect((await check()).status).toBe(403);
  });
});

describe('device authorization on the Worker runtime', () => {
  test('issues an isolated CLI session and enforces its route boundary', async () => {
    const browser = await createBrowserSession();
    expect(browser.cookie).toContain('better-auth.session_token=');
    const browserIdentity = await request('/api/auth/get-session', {
      headers: { cookie: browser.cookie },
    });
    expect(browserIdentity.status).toBe(200);
    await expect(browserIdentity.json()).resolves.toMatchObject({
      user: { id: browser.user.id },
    });
    const device = await requestDeviceCode();

    const claim = await request(`/api/auth/device?user_code=${device.user_code}`, {
      headers: { cookie: browser.cookie },
    });
    expect(claim.status).toBe(200);
    await expect(claim.json()).resolves.toMatchObject({
      user_code: device.user_code,
      status: 'pending',
    });

    const approve = await request('/api/auth/device/approve', {
      method: 'POST',
      headers: jsonHeaders({ cookie: browser.cookie }),
      body: JSON.stringify({ userCode: device.user_code }),
    });
    expect(approve.status).toBe(200);

    const exchange = await exchangeDeviceCode(device.device_code);
    expect(exchange.status).toBe(200);
    const token = (await exchange.json() as { access_token: string }).access_token;
    expect(token).toBeTruthy();

    const account = await request('/v1/account', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(account.status).toBe(200);
    await expect(account.json()).resolves.toMatchObject({
      user: { id: browser.user.id, email: browser.user.email },
      authentication: { method: 'cli-session' },
    });

    const usage = await request('/v1/usage', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(usage.status).toBe(200);
    await expect(usage.json()).resolves.toMatchObject({ creditBalance: expect.any(Number) });

    const monitors = await request('/v1/monitors', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(monitors.status).toBe(200);
    await expect(monitors.json()).resolves.toEqual({ monitors: [] });

    const replay = await exchangeDeviceCode(device.device_code);
    expect(replay.status).toBe(400);
    await expect(replay.json()).resolves.toMatchObject({ error: expect.any(String) });

    const deleteAccount = await request('/v1/account', {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(deleteAccount.status).toBe(403);

    const createKey = await request('/api/auth/api-key/create', {
      method: 'POST',
      headers: jsonHeaders({ authorization: `Bearer ${token}` }),
      body: JSON.stringify({ name: 'forbidden' }),
    });
    expect(createKey.status).toBe(403);

    const logout = await request('/api/auth/sign-out', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, origin: baseUrl },
    });
    expect(logout.status).toBe(200);

    const revoked = await request('/v1/account', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(revoked.status).toBe(401);
  });

  test('rejects unknown clients and denied device requests', async () => {
    const invalid = await request('/api/auth/device/code', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ client_id: 'unknown-client' }),
    });
    expect(invalid.status).toBe(400);

    const invalidScope = await request('/api/auth/device/code', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        client_id: 'video2ctx-cli',
        scope: 'admin:write',
      }),
    });
    expect(invalidScope.status).toBe(400);
    await expect(invalidScope.json()).resolves.toMatchObject({
      error: 'invalid_request',
      error_description: 'Unsupported scope',
    });

    const browser = await createBrowserSession();
    const device = await requestDeviceCode();
    await request(`/api/auth/device?user_code=${device.user_code}`, {
      headers: { cookie: browser.cookie },
    });
    const deny = await request('/api/auth/device/deny', {
      method: 'POST',
      headers: jsonHeaders({ cookie: browser.cookie }),
      body: JSON.stringify({ userCode: device.user_code }),
    });
    expect(deny.status).toBe(200);

    const exchange = await exchangeDeviceCode(device.device_code);
    expect(exchange.status).toBe(400);
    await expect(exchange.json()).resolves.toMatchObject({ error: 'access_denied' });
  });
});

async function createBrowserSession(): Promise<{
  user: { id: string; email: string };
  cookie: string;
}> {
  const response = await request('/__test/session', { method: 'POST' });
  expect(response.status).toBe(200);
  return response.json();
}

async function requestDeviceCode(): Promise<{
  device_code: string;
  user_code: string;
}> {
  const response = await request('/api/auth/device/code', {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({
      client_id: 'video2ctx-cli',
      scope: 'data:read account:access',
    }),
  });
  expect(response.status).toBe(200);
  return response.json();
}

function exchangeDeviceCode(deviceCode: string): Promise<Response> {
  return request('/api/auth/device/token', {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: deviceCode,
      client_id: 'video2ctx-cli',
    }),
  });
}

function request(path: string, init?: RequestInit): Promise<Response> {
  return worker.fetch(new Request(new URL(path, baseUrl), init));
}

function jsonHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { 'content-type': 'application/json', origin: baseUrl, ...extra };
}
