const captured = vi.hoisted(() => ({
  apiKey: undefined as Record<string, any> | undefined,
  auth: undefined as Record<string, any> | undefined,
  bearer: undefined as Record<string, any> | undefined,
  deviceAuthorization: undefined as Record<string, any> | undefined,
  checkout: undefined as Record<string, any> | undefined,
  portal: undefined as Record<string, any> | undefined,
  webhooks: undefined as Record<string, any> | undefined,
  polar: undefined as Record<string, any> | undefined,
  oauthProxy: undefined as Record<string, any> | undefined,
  magicLink: undefined as Record<string, any> | undefined,
}));

vi.mock('@better-auth/api-key', () => ({
  apiKey: vi.fn((options: Record<string, any>) => {
    captured.apiKey = options;
    return { id: 'api-key' };
  }),
}));
vi.mock('better-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('better-auth')>();
  return {
    ...actual,
    betterAuth: vi.fn((options) => {
      captured.auth = options;
      return { options };
    }),
  };
});
vi.mock('better-auth/plugins', () => ({
  admin: vi.fn((options?: Record<string, any>) => ({ id: 'admin', options })),
  bearer: vi.fn((options?: Record<string, any>) => {
    captured.bearer = options ?? {};
    return { id: 'bearer' };
  }),
  deviceAuthorization: vi.fn((options: Record<string, any>) => {
    captured.deviceAuthorization = options;
    return { id: 'device-authorization' };
  }),
  magicLink: vi.fn((options: Record<string, any>) => {
    captured.magicLink = options;
    return { id: 'magic-link' };
  }),
  oAuthProxy: vi.fn((options: Record<string, any>) => {
    captured.oauthProxy = options;
    return { id: 'oauth-proxy' };
  }),
}));
vi.mock('@polar-sh/sdk', () => ({
  Polar: vi.fn(class {
    customers = { deleteExternal: vi.fn() };
  }),
}));
vi.mock('@polar-sh/better-auth', () => ({
  checkout: vi.fn((options: Record<string, any>) => {
    captured.checkout = options;
    return () => ({ id: 'polar-checkout' });
  }),
  portal: vi.fn((options: Record<string, any>) => {
    captured.portal = options;
    return () => ({ id: 'polar-portal' });
  }),
  webhooks: vi.fn((options: Record<string, any>) => {
    captured.webhooks = options;
    return () => ({ id: 'polar-webhooks' });
  }),
  polar: vi.fn((options: Record<string, any>) => {
    captured.polar = options;
    return { id: 'polar' };
  }),
}));

import { checkoutIntentHook, createAuth } from '../src/lib/auth';

describe('Better Auth API-key configuration', () => {
  test('creates permanent hashed user keys with strict rate and permission defaults', () => {
    createAuth({
      AUTH_BASE_URL: 'http://localhost:3000',
      APP_ORIGIN: 'http://localhost:3000',
      AUTH_PREVIEW_HOST_PATTERN: 'video2ctx-web-*-devhims-projects.vercel.app',
      BETTER_AUTH_SECRET: 'test-secret-that-is-long-enough-for-tests',
      OAUTH_PROXY_SECRET: 'test-oauth-proxy-secret-that-is-long-enough',
      GITHUB_CLIENT_ID: 'github-client',
      GITHUB_CLIENT_SECRET: 'github-secret',
      GOOGLE_CLIENT_ID: 'google-client',
      GOOGLE_CLIENT_SECRET: 'google-secret',
      POLAR_ACCESS_TOKEN: 'polar-token',
      POLAR_WEBHOOK_SECRET: 'polar-webhook-secret',
      POLAR_BUILDER_PRODUCT_ID: 'builder-product',
      POLAR_ENVIRONMENT: 'sandbox',
    } as unknown as Env, { waitUntil: vi.fn() });

    expect(captured.apiKey).toMatchObject({
      apiKeyHeaders: 'x-api-key',
      defaultPrefix: 'aty_',
      defaultKeyLength: 64,
      requireName: true,
      storage: 'database',
      references: 'user',
      enableSessionForAPIKeys: false,
      deferUpdates: false,
      keyExpiration: { defaultExpiresIn: null, disableCustomExpiresTime: true },
      rateLimit: { enabled: true, timeWindow: 60_000, maxRequests: 60 },
      permissions: { defaultPermissions: { data: ['read'], account: ['access'] } },
    });
    expect(captured.apiKey?.disableKeyHashing).not.toBe(true);
    expect(captured.auth?.socialProviders).toEqual({
      google: { clientId: 'google-client', clientSecret: 'google-secret', scope: ['openid', 'email', 'profile'] },
      github: { clientId: 'github-client', clientSecret: 'github-secret' },
    });
    expect(captured.auth?.baseURL).toEqual({
      allowedHosts: ['localhost:3000', 'video2ctx-web-*-devhims-projects.vercel.app'],
      fallback: 'http://localhost:3000',
    });
    expect(captured.auth?.trustedOrigins).toEqual([
      'http://localhost:3000',
      'https://video2ctx-web-*-devhims-projects.vercel.app',
    ]);
    expect(captured.oauthProxy).toEqual({
      productionURL: 'http://localhost:3000',
      secret: 'test-oauth-proxy-secret-that-is-long-enough',
      maxAge: 60,
    });
    expect(captured.auth?.account).toEqual({ encryptOAuthTokens: true });
    expect(captured.auth?.session).toEqual({
      cookieCache: { enabled: true, maxAge: 60 * 5 },
    });
  });

  test('enables the fixed public CLI device flow and bearer session transport', async () => {
    createAuth({
      AUTH_BASE_URL: 'http://localhost:3000',
      APP_ORIGIN: 'http://localhost:3000',
      AUTH_PREVIEW_HOST_PATTERN: 'video2ctx-web-*-devhims-projects.vercel.app',
      BETTER_AUTH_SECRET: 'test-secret-that-is-long-enough-for-tests',
      OAUTH_PROXY_SECRET: 'test-oauth-proxy-secret-that-is-long-enough',
      GOOGLE_CLIENT_ID: 'google-client',
      GOOGLE_CLIENT_SECRET: 'google-secret',
      POLAR_ACCESS_TOKEN: 'polar-token',
      POLAR_WEBHOOK_SECRET: 'polar-webhook-secret',
      POLAR_BUILDER_PRODUCT_ID: 'builder-product',
      POLAR_ENVIRONMENT: 'sandbox',
    } as unknown as Env, { waitUntil: vi.fn() });

    expect(captured.deviceAuthorization).toMatchObject({
      verificationUri: '/device',
      expiresIn: '15m',
      interval: '5s',
    });
    await expect(captured.deviceAuthorization?.validateClient('video2ctx-cli')).resolves.toBe(true);
    await expect(captured.deviceAuthorization?.validateClient('unknown-client')).resolves.toBe(false);
    await expect(captured.deviceAuthorization?.onDeviceAuthRequest(
      'video2ctx-cli',
      'data:read account:access',
    )).resolves.toBeUndefined();
    await expect(captured.deviceAuthorization?.onDeviceAuthRequest(
      'video2ctx-cli',
      'admin:write',
    )).rejects.toMatchObject({
      status: 'BAD_REQUEST',
      body: { error: 'invalid_request', error_description: 'Unsupported scope' },
    });
    expect(captured.bearer).toEqual({});
    expect(captured.auth?.plugins).toEqual(expect.arrayContaining([
      { id: 'oauth-proxy' },
      { id: 'admin', options: { adminUserIds: [] } },
      { id: 'api-key' },
      { id: 'bearer' },
      { id: 'device-authorization' },
      { id: 'magic-link' },
      { id: 'polar' },
    ]));
  });

  test('uses Polar for authenticated checkout, customer self-service, and signed lifecycle webhooks', () => {
    createAuth({
      AUTH_BASE_URL: 'http://localhost:3000',
      APP_ORIGIN: 'http://localhost:3000',
      AUTH_PREVIEW_HOST_PATTERN: 'video2ctx-web-*-devhims-projects.vercel.app',
      BETTER_AUTH_SECRET: 'test-secret-that-is-long-enough-for-tests',
      OAUTH_PROXY_SECRET: 'test-oauth-proxy-secret-that-is-long-enough',
      GOOGLE_CLIENT_ID: 'google-client',
      GOOGLE_CLIENT_SECRET: 'google-secret',
      POLAR_ACCESS_TOKEN: 'polar-token',
      POLAR_WEBHOOK_SECRET: 'polar-webhook-secret',
      POLAR_BUILDER_PRODUCT_ID: 'builder-product',
      POLAR_ENVIRONMENT: 'sandbox',
    } as unknown as Env, { waitUntil: vi.fn() });

    expect(captured.polar).toMatchObject({ createCustomerOnSignUp: false });
    expect(captured.checkout).toEqual({
      products: [{ productId: 'builder-product', slug: 'builder' }],
      successUrl: 'http://localhost:3000/dashboard?section=settings&checkout=success',
      returnUrl: 'http://localhost:3000/dashboard?section=settings&checkout=cancelled',
      authenticatedUsersOnly: true,
    });
    expect(captured.portal).toEqual({ returnUrl: 'http://localhost:3000/dashboard?section=settings' });
    expect(captured.webhooks).toMatchObject({ secret: 'polar-webhook-secret' });
    expect(captured.webhooks?.onOrderPaid).toEqual(expect.any(Function));
    expect(captured.webhooks?.onOrderRefunded).toEqual(expect.any(Function));
    expect(captured.webhooks?.onCustomerStateChanged).toEqual(expect.any(Function));
    expect(captured.webhooks?.onSubscriptionRevoked).toEqual(expect.any(Function));
  });

  test('queues the welcome email in the background after a user is created', async () => {
    const send = vi.fn(async () => undefined);
    const waitUntil = vi.fn();
    createAuth({ ...welcomeAuthEnv(), EMAIL_TASKS: { send } } as unknown as Env, { waitUntil });

    await captured.auth!.databaseHooks.user.create.after({ id: 'user-1', email: 'ari@customer.test', name: 'Ari Lee' }, null);

    expect(waitUntil).toHaveBeenCalledOnce();
    await waitUntil.mock.calls[0]?.[0];
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'welcome', idempotencyKey: 'welcome:user-1' }), { contentType: 'json' });
  });

  test('does not fail signup when the welcome email cannot be queued', async () => {
    const send = vi.fn(async () => { throw new Error('queue unavailable'); });
    const waitUntil = vi.fn();
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    createAuth({ ...welcomeAuthEnv(), EMAIL_TASKS: { send } } as unknown as Env, { waitUntil });

    await expect(captured.auth!.databaseHooks.user.create.after({ id: 'user-2', email: 'ari@customer.test', name: 'Ari' }, null)).resolves.toBeUndefined();
    await expect(waitUntil.mock.calls[0]?.[0]).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: 'welcome_email_queue_failed' }));
    log.mockRestore();
  });
});

test('queues the sign-in link through the branded template', async () => {
  const send = vi.fn(async () => undefined);
  createAuth({ ...welcomeAuthEnv(), EMAIL_TASKS: { send } } as unknown as Env, { waitUntil: vi.fn() });

  await captured.magicLink!.sendMagicLink({ email: 'ari@customer.test', url: 'https://x.test/verify?token=abc' });

  const [message] = send.mock.calls[0] as unknown as [Record<string, any>];
  expect(message).toMatchObject({ type: 'magic-link', to: 'ari@customer.test', subject: 'Sign in to video2ctx' });
  expect(message.idempotencyKey).toMatch(/^magic:[0-9a-f]{64}$/);
  expect(message.html).toContain('href="https://x.test/verify?token=abc"');
  expect(message.html).toContain('src="cid:video2ctx-logo"');
});

describe('checkout intent hook', () => {
  function hookEnv(overrides: Record<string, unknown> = {}, run = vi.fn(async () => ({ success: true }))) {
    const bind = vi.fn(() => ({ run }));
    const env = { POLAR_ACCESS_TOKEN: 'polar-token', POLAR_BUILDER_PRODUCT_ID: 'builder-product', DB: { prepare: vi.fn(() => ({ bind })) }, ...overrides };
    return { env: env as unknown as Env, bind };
  }
  const signedIn = async () => ({ user: { id: 'user-1' } });
  const checkout = (body?: Record<string, unknown>) => ({ path: '/checkout', body }) as never;

  test('is installed as a global before hook', () => {
    createAuth(welcomeAuthEnv() as unknown as Env, { waitUntil: vi.fn() });
    expect(captured.auth?.hooks?.before).toEqual(expect.any(Function));
  });

  test('records the intent before a valid signed-in checkout reaches Polar', async () => {
    const { env, bind } = hookEnv();
    await checkoutIntentHook(env, signedIn)(checkout({ slug: 'builder' }));
    await checkoutIntentHook(env, signedIn)(checkout({ products: ['product-id'] }));
    expect(bind).toHaveBeenCalledTimes(2);
    expect(bind).toHaveBeenCalledWith('user-1', expect.any(Number));
  });

  test('ignores other auth paths and signed-out checkout requests', async () => {
    const { env, bind } = hookEnv();
    await checkoutIntentHook(env, signedIn)({ path: '/sign-in/social' } as never);
    await checkoutIntentHook(env, async () => null)(checkout({ slug: 'builder' }));
    expect(bind).not.toHaveBeenCalled();
  });

  test('refuses checkout without recording anything while billing is unconfigured', async () => {
    for (const token of ['', undefined]) {
      const { env, bind } = hookEnv({ POLAR_ACCESS_TOKEN: token });
      await expect(checkoutIntentHook(env, signedIn)(checkout({ slug: 'builder' }))).rejects.toMatchObject({ statusCode: 503 });
      expect(bind).not.toHaveBeenCalled();
    }
  });

  test('refuses an unknown or unconfigured product without recording anything', async () => {
    const unknown = hookEnv();
    await expect(checkoutIntentHook(unknown.env, signedIn)(checkout({ slug: 'enterprise' }))).rejects.toMatchObject({ statusCode: 400 });
    const unconfigured = hookEnv({ POLAR_BUILDER_PRODUCT_ID: '' });
    await expect(checkoutIntentHook(unconfigured.env, signedIn)(checkout({ slug: 'builder' }))).rejects.toMatchObject({ statusCode: 400 });
    expect(unknown.bind).not.toHaveBeenCalled();
    expect(unconfigured.bind).not.toHaveBeenCalled();
  });

  test('aborts checkout when the intent cannot be recorded', async () => {
    const { env } = hookEnv({}, vi.fn(async () => { throw new Error('D1 unavailable'); }));
    await expect(checkoutIntentHook(env, signedIn)(checkout({ slug: 'builder' }))).rejects.toThrow('D1 unavailable');
  });
});

function welcomeAuthEnv() {
  return {
    AUTH_BASE_URL: 'http://localhost:3000',
    APP_ORIGIN: 'http://localhost:3000',
    BETTER_AUTH_SECRET: 'test-secret-that-is-long-enough-for-tests',
    OAUTH_PROXY_SECRET: 'test-oauth-proxy-secret-that-is-long-enough',
    POLAR_ACCESS_TOKEN: 'polar-token',
    POLAR_WEBHOOK_SECRET: 'polar-webhook-secret',
    POLAR_BUILDER_PRODUCT_ID: 'builder-product',
    POLAR_ENVIRONMENT: 'sandbox',
    STARTER_ONBOARDING_CREDITS: '1000',
    WELCOME_EMAIL_FROM: 'himanshu@notify.video2ctx.dev',
  };
}
