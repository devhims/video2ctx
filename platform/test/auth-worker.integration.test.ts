import { Webhook } from 'standardwebhooks';
import { env, exports } from 'cloudflare:workers';
import { describe, expect, test, vi } from 'vitest';

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

  test('proxies an allowed Vercel preview through the fixed production Google callback', async () => {
    const previewOrigin = 'https://video2ctx-web-git-fix-trend-lab-empty-topic-devhims-projects.vercel.app';
    const response = await worker.fetch(new Request('http://api.test/api/auth/sign-in/social', {
      method: 'POST',
      headers: jsonHeaders({
        origin: previewOrigin,
        'x-forwarded-host': new URL(previewOrigin).host,
        'x-forwarded-proto': 'https',
      }),
      body: JSON.stringify({
        provider: 'google',
        callbackURL: `${previewOrigin}/dashboard/sessions`,
        errorCallbackURL: `${previewOrigin}/login`,
      }),
    }));
    expect(response.status).toBe(200);
    const { url } = await response.json() as { url: string };
    const authorization = new URL(url);
    expect(authorization.searchParams.get('redirect_uri')).toBe(`${baseUrl}/api/auth/callback/google`);
    expect(authorization.searchParams.get('state')?.length).toBeGreaterThan(100);
    expect(response.headers.get('set-cookie')).toContain('better-auth.state=');

    const untrustedOrigin = 'https://unrelated-project.vercel.app';
    const rejected = await worker.fetch(new Request('http://api.test/api/auth/sign-in/social', {
      method: 'POST',
      headers: jsonHeaders({ origin: untrustedOrigin, 'x-forwarded-host': new URL(untrustedOrigin).host }),
      body: JSON.stringify({ provider: 'google', callbackURL: `${untrustedOrigin}/dashboard` }),
    }));
    expect(rejected.status).toBe(403);
  });
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

describe('signed Polar webhook delivery', () => {
  for (const scheme of ['standard', 'legacy'] as const) {
    test(`accepts ${scheme} signatures and projects customer state without a payment`, async () => {
      const browser = await createBrowserSession();
      const body = customerStateBody(browser.user.id);
      const response = await request('/api/auth/polar/webhooks', {
        method: 'POST', headers: signedHeaders(body, scheme), body,
      });
      expect(response.status).toBeGreaterThanOrEqual(200);
      expect(response.status).toBeLessThan(300);
      const billing = await request('/v1/billing', { headers: { cookie: browser.cookie } });
      expect(await billing.json()).toMatchObject({
        plan: 'starter', status: 'inactive', creditBalance: 1000, canManageBilling: true,
      });
    });
  }

  test('rejects signed invalid payloads and oversized bodies without changing billing', async () => {
    const browser = await createBrowserSession();
    const invalidBody = JSON.stringify({ type: 'customer.state_changed', data: {} });
    const invalid = await request('/api/auth/polar/webhooks', {
      method: 'POST', headers: signedHeaders(invalidBody, 'standard'), body: invalidBody,
    });
    expect(invalid.status).toBe(400);
    const oversized = await request('/api/auth/polar/webhooks', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ padding: 'x'.repeat(1_048_576) }),
    });
    expect(oversized.status).toBe(413);
    const billing = await request('/v1/billing', { headers: { cookie: browser.cookie } });
    expect(await billing.json()).toMatchObject({ plan: 'starter', creditBalance: 1000, canManageBilling: false });
  });

  test('returns a retryable failure when a verified event cannot be applied', async () => {
    const payload = JSON.parse(customerStateBody('unlinked-customer'));
    payload.data.external_id = null;
    const body = JSON.stringify(payload);
    const response = await request('/api/auth/polar/webhooks', {
      method: 'POST', headers: signedHeaders(body, 'standard'), body,
    });
    expect(response.status).toBe(500);
  });

  test('rejects tampered bodies and stale signatures without changing billing', async () => {
    const browser = await createBrowserSession();
    const body = customerStateBody(browser.user.id);
    for (const [sentBody, headers] of [
      [body.replace('Signature Test', 'Tampered'), signedHeaders(body, 'standard')],
      [body, signedHeaders(body, 'standard', new Date(Date.now() - 600_000))],
      [body, { 'content-type': 'application/json' }],
    ] as const) {
      const response = await request('/api/auth/polar/webhooks', {
        method: 'POST', headers, body: sentBody,
      });
      expect(response.status).toBe(400);
    }
    const billing = await request('/v1/billing', { headers: { cookie: browser.cookie } });
    expect(await billing.json()).toMatchObject({ plan: 'starter', creditBalance: 1000, canManageBilling: false });
  });
});

function customerStateBody(userId: string): string {
  return JSON.stringify({
    type: 'customer.state_changed', timestamp: new Date().toISOString(),
    data: {
      id: `customer-${userId}`, external_id: userId, type: 'individual',
      created_at: new Date().toISOString(), modified_at: null, metadata: {},
      email: 'signature-test@example.test', email_verified: true, name: 'Signature Test',
      billing_address: null, tax_id: null, organization_id: 'sandbox-test-org', deleted_at: null,
      active_subscriptions: [], granted_benefits: [], active_meters: [], avatar_url: '',
    },
  });
}

function signedHeaders(body: string, scheme: 'standard' | 'legacy', timestamp = new Date()): Record<string, string> {
  const secret = (env as Env).POLAR_WEBHOOK_SECRET;
  const signingKey = scheme === 'standard' ? secret : Buffer.from(secret).toString('base64');
  const id = crypto.randomUUID();
  return {
    'content-type': 'application/json', 'webhook-id': id,
    'webhook-timestamp': String(Math.floor(timestamp.getTime() / 1000)),
    'webhook-signature': new Webhook(signingKey).sign(id, timestamp, body),
  };
}

describe('authenticated Builder checkout identity', () => {
  test('requires a session and a configured product before contacting Polar', async () => {
    const signedOut = await request('/api/auth/checkout', {
      method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ slug: 'builder' }),
    });
    expect(signedOut.status).toBe(401);
    const browser = await createBrowserSession();
    const unknownProduct = await request('/api/auth/checkout', {
      method: 'POST', headers: jsonHeaders({ cookie: browser.cookie }), body: JSON.stringify({ slug: 'unknown' }),
    });
    expect(unknownProduct.status).toBe(400);
  });

  test('sends the signed-in email and user ID to Polar instead of accepting a buyer identity from the browser', async () => {
    const browser = await createBrowserSession();
    let sent: Record<string, unknown> | undefined;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const outgoing = new Request(input, init);
      expect(outgoing.url).toBe('https://sandbox-api.polar.sh/v1/checkouts/');
      sent = await outgoing.json() as Record<string, unknown>;
      // Stop at the provider boundary; no checkout or payment is created.
      return Response.json({ detail: 'Isolated checkout request inspection' }, { status: 400 });
    });
    try {
      const response = await request('/api/auth/checkout', {
        method: 'POST', headers: jsonHeaders({ cookie: browser.cookie }),
        body: JSON.stringify({
          slug: 'builder', products: ['other-product'],
          customerEmail: 'other@example.test', externalCustomerId: 'other-user',
          metadata: { app_user_id: 'other-user' },
          successUrl: 'https://other.example.test/success', returnUrl: 'https://other.example.test/cancel',
        }),
      });
      expect(response.status).toBe(500);
      expect(sent).toMatchObject({
        products: ['builder-product'], external_customer_id: browser.user.id, customer_email: browser.user.email,
        metadata: { app_user_id: browser.user.id }, customer_name: 'Auth Test User',
        success_url: `${baseUrl}/dashboard?section=settings&checkout=success`,
        return_url: `${baseUrl}/dashboard?section=settings&checkout=cancelled`,
      });
      expect(sent?.customer_email).not.toBe('other@example.test');
      expect(fetchSpy).toHaveBeenCalledOnce();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
