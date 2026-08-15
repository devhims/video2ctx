import { exports } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';

const worker = exports.default;
const baseUrl = 'http://auth.test';

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
