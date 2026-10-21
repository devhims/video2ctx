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
  test.each(['subscription.created', 'subscription.updated'] as const)('projects signed %s events without granting credits', async (type) => {
    const browser = await createBrowserSession();
    const body = subscriptionBody(browser.user, type);
    const response = await request('/api/auth/polar/webhooks', {
      method: 'POST', headers: signedHeaders(body, 'standard'), body,
    });
    expect(response.status).toBe(200);
    const billing = await request('/v1/billing', { headers: { cookie: browser.cookie } });
    expect(await billing.json()).toMatchObject({
      plan: 'starter', creditBalance: 5000, canManageBilling: true, needsBillingAttention: true,
    });
    const invalid = JSON.parse(body);
    delete invalid.data.customer;
    const invalidBody = JSON.stringify(invalid);
    const rejected = await request('/api/auth/polar/webhooks', {
      method: 'POST', headers: signedHeaders(invalidBody, 'standard'), body: invalidBody,
    });
    expect(rejected.status).toBe(400);
  });

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
        plan: 'starter', status: 'inactive', creditBalance: 5000, canManageBilling: false, needsBillingAttention: false,
      });
    });
  }

  test('acknowledges a terminal customer identity conflict without upgrading either account', async () => {
    const payer = await createBrowserSession();
    const other = await createBrowserSession();
    const payload = JSON.parse(customerStateBody(other.user.id));
    const at = new Date().toISOString();
    payload.data.active_subscriptions = [{
      id: 'conflicting-subscription', created_at: at, modified_at: null,
      metadata: { app_user_id: payer.user.id }, status: 'active', amount: 2000, currency: 'usd',
      recurring_interval: 'month', current_period_start: at, current_period_end: at,
      trial_start: null, trial_end: null, cancel_at_period_end: false, canceled_at: null,
      started_at: at, ends_at: null, product_id: 'builder-product', discount_id: null, meters: [],
    }];
    const body = JSON.stringify(payload);
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await request('/api/auth/polar/webhooks', {
        method: 'POST', headers: signedHeaders(body, 'standard'), body,
      });
      expect(response.status).toBe(200);
    }
    for (const browser of [payer, other]) {
      const summary = await request('/v1/billing', { headers: { cookie: browser.cookie } });
      expect(await summary.json()).toMatchObject({ plan: 'starter', creditBalance: 5000 });
    }
    const alerts = await request('/v1/notifications', { headers: { cookie: payer.cookie } });
    expect(await alerts.json()).toMatchObject({ notifications: [] });
  });

  test('acknowledges unhandled verified events but still rejects their invalid signatures', async () => {
    for (const type of ['order.created', 'product.updated', 'future.event']) {
      const body = JSON.stringify({ type, timestamp: new Date().toISOString(), data: { id: 'unhandled-resource' } });
      const accepted = await request('/api/auth/polar/webhooks', {
        method: 'POST', headers: signedHeaders(body, 'standard'), body,
      });
      expect(accepted.status).toBe(200);
      expect(await accepted.json()).toEqual({ received: true });
      const rejected = await request('/api/auth/polar/webhooks', {
        method: 'POST', headers: signedHeaders(body, 'standard'), body: body.replace('unhandled-resource', 'tampered'),
      });
      expect(rejected.status).toBe(400);
    }
  });

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
    expect(await billing.json()).toMatchObject({ plan: 'starter', creditBalance: 5000, canManageBilling: false });
  });

  test('returns a retryable failure with safe event diagnostics when a verified event cannot be applied', async () => {
    const payload = JSON.parse(customerStateBody('unlinked-customer'));
    payload.data.external_id = null;
    const body = JSON.stringify(payload);
    const headers = signedHeaders(body, 'standard');
    const logs = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const response = await request('/api/auth/polar/webhooks', { method: 'POST', headers, body });
      expect(response.status).toBe(500);
      expect(logs).toHaveBeenCalledWith(expect.objectContaining({
        event: 'polar_webhook_processing_failed', eventType: 'customer.state_changed',
        resourceId: 'customer-unlinked-customer', webhookId: headers['webhook-id'], errorName: 'Error',
        errorCode: 'POLAR_MISSING_CUSTOMER_EXTERNAL_ID',
      }));
      expect(JSON.stringify(logs.mock.calls)).not.toContain('signature-test@example.test');
    } finally { logs.mockRestore(); }
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
    expect(await billing.json()).toMatchObject({ plan: 'starter', creditBalance: 5000, canManageBilling: false });
  });
});

function subscriptionBody(user: { id: string; email: string }, type: 'subscription.created' | 'subscription.updated'): string {
  const at = new Date().toISOString();
  const customer = polarCustomer(user);
  return JSON.stringify({
    type, timestamp: at,
    data: {
      id: `subscription-${user.id}`, created_at: at, modified_at: null,
      amount: 2000, currency: 'usd', recurring_interval: 'month', recurring_interval_count: 1,
      status: type === 'subscription.created' ? 'incomplete' : 'past_due',
      current_period_start: at, current_period_end: at, trial_start: null, trial_end: null,
      cancel_at_period_end: false, canceled_at: null, started_at: at, ends_at: null, ended_at: null,
      customer_id: customer.id, product_id: 'builder-product', discount_id: null, checkout_id: null,
      customer_cancellation_reason: null, customer_cancellation_comment: null,
      metadata: { app_user_id: user.id }, customer,
      product: {
        id: 'builder-product', created_at: at, modified_at: null, trial_interval: null, trial_interval_count: null,
        name: 'Builder', description: null, visibility: 'public', recurring_interval: 'month', recurring_interval_count: 1,
        is_recurring: true, is_archived: false, organization_id: 'sandbox-organization',
        metadata: {}, prices: [], benefits: [], medias: [], attached_custom_fields: [],
      },
      discount: null, prices: [], meters: [], pending_update: null,
    },
  });
}

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

  test('binds checkout to the signed-in customer instead of accepting a buyer identity from the browser', async () => {
    const browser = await createBrowserSession();
    let sent: Record<string, unknown> | undefined;
    const logs = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const outgoing = new Request(input, init);
      if (outgoing.method === 'GET') {
        expect(outgoing.url).toBe(`https://sandbox-api.polar.sh/v1/customers/external/${browser.user.id}`);
        return Response.json(polarCustomer(browser.user));
      }
      expect(outgoing.url).toBe('https://sandbox-api.polar.sh/v1/checkouts/');
      sent = await outgoing.json() as Record<string, unknown>;
      // Stop at the provider boundary; no checkout or payment is created.
      return Response.json({ detail: 'private@example.test polar_private_token' }, { status: 400 });
    });
    try {
      const response = await request('/api/auth/checkout', {
        method: 'POST', headers: jsonHeaders({ cookie: browser.cookie }),
        body: JSON.stringify({
          slug: 'builder', products: { ignored: 'invalid' }, embedOrigin: 'not-a-url', allowTrial: 'invalid',
          customerEmail: 'other@example.test', externalCustomerId: 'other-user',
          metadata: { app_user_id: 'other-user', ignored: { invalid: true } },
          successUrl: 'https://other.example.test/success', returnUrl: 'https://other.example.test/cancel',
        }),
      });
      expect(response.status).toBe(500);
      expect(sent).toMatchObject({
        products: ['builder-product'], customer_id: 'customer-for-signed-in-user',
        metadata: { app_user_id: browser.user.id },
        success_url: `${baseUrl}/dashboard?section=settings&checkout=success`,
        return_url: `${baseUrl}/dashboard?section=settings&checkout=cancelled`,
      });
      expect(sent).not.toHaveProperty('customer_email');
      expect(sent).not.toHaveProperty('external_customer_id');
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(logs).toHaveBeenCalledWith(expect.objectContaining({
        event: 'polar_checkout_failed', userId: browser.user.id, productId: 'builder-product',
        errorName: expect.any(String), statusCode: 400,
      }));
      expect(JSON.stringify(logs.mock.calls)).not.toContain('private@example.test');
      expect(JSON.stringify(logs.mock.calls)).not.toContain('polar_private_token');
    } finally {
      fetchSpy.mockRestore();
      logs.mockRestore();
    }
  });

  test.each(['new customer', 'creation race', 'old email', 'wrong external ID', 'different email', 'deleted customer', 'forbidden lookup', 'forbidden creation', 'lookup outage'])(
    'verifies customer ownership before checkout: %s', async (scenario) => {
      const browser = await createBrowserSession();
      const customer = polarCustomer(browser.user);
      if (scenario === 'wrong external ID') customer.external_id = 'deleted-old-account';
      if (scenario === 'different email') customer.email = 'other@example.test';
      if (scenario === 'deleted customer') customer.deleted_at = new Date().toISOString();
      const calls: string[] = [];
      let lookups = 0;
      const logs = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const outgoing = new Request(input, init);
        calls.push(`${outgoing.method} ${new URL(outgoing.url).pathname}`);
        if (outgoing.method === 'GET') {
          expect(outgoing.url).toBe(`https://sandbox-api.polar.sh/v1/customers/external/${browser.user.id}`);
          lookups++;
          if (scenario === 'forbidden lookup' || scenario === 'lookup outage') {
            return Response.json({ detail: 'Lookup failed' }, { status: scenario === 'forbidden lookup' ? 403 : 503 });
          }
          if (scenario === 'old email' || scenario === 'forbidden creation'
            || (lookups === 1 && ['new customer', 'creation race'].includes(scenario))) {
            return Response.json({ error: 'ResourceNotFound', detail: 'Customer not found' }, { status: 404 });
          }
          return Response.json(customer);
        }
        const data = await outgoing.json();
        if (outgoing.url.endsWith('/customers/')) {
          expect(data).toMatchObject({ external_id: browser.user.id, email: browser.user.email, name: 'Auth Test User' });
          if (scenario === 'forbidden creation') return Response.json({ error: 'insufficient_scope', detail: 'Denied' }, { status: 403 });
          if (scenario === 'old email' || scenario === 'creation race') {
            return Response.json({ detail: 'Customer already exists' }, { status: 422 });
          }
          return Response.json(customer, { status: 201 });
        }
        expect(data).toMatchObject({ customer_id: customer.id, metadata: { app_user_id: browser.user.id } });
        expect(data).not.toHaveProperty('customer_email');
        return Response.json({ detail: 'stop before checkout creation' }, { status: 400 });
      });
      try {
        const response = await request('/api/auth/checkout', { method: 'POST', headers: jsonHeaders({ cookie: browser.cookie }),
          body: JSON.stringify({ slug: 'builder', customerId: 'spoof-customer', customerEmail: 'spoof@example.test' }) });
        const conflict = ['old email', 'wrong external ID', 'different email', 'deleted customer'].includes(scenario);
        expect(response.status).toBe(conflict ? 409 : 500);
        expect(calls.some(call => call.endsWith('/checkouts/'))).toBe(['new customer', 'creation race'].includes(scenario));
        expect(calls).toHaveLength(scenario === 'creation race' ? 4 : ['new customer', 'old email'].includes(scenario) ? 3 : scenario === 'forbidden creation' ? 2 : 1);
        if (conflict) expect(logs).toHaveBeenCalledWith(expect.objectContaining({ errorCode: expect.stringMatching(/^POLAR_CUSTOMER_IDENTITY_/) }));
      } finally { fetchSpy.mockRestore(); logs.mockRestore(); }
    });
});

function polarCustomer(user: { id: string; email: string }) {
  return {
    id: 'customer-for-signed-in-user', created_at: '2026-10-14T00:00:00Z', modified_at: null, metadata: {},
    external_id: user.id, email: user.email, email_verified: false, type: 'individual', name: 'Auth Test User',
    billing_address: null, tax_id: null, organization_id: 'sandbox-organization', deleted_at: null as string | null,
    avatar_url: 'https://example.test/avatar',
  };
}
