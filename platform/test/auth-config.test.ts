const captured = vi.hoisted(() => ({
  apiKey: undefined as Record<string, any> | undefined,
  auth: undefined as Record<string, any> | undefined,
  bearer: undefined as Record<string, any> | undefined,
  deviceAuthorization: undefined as Record<string, any> | undefined,
  checkout: undefined as Record<string, any> | undefined,
  portal: undefined as Record<string, any> | undefined,
  webhooks: undefined as Record<string, any> | undefined,
  polar: undefined as Record<string, any> | undefined,
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
  bearer: vi.fn((options?: Record<string, any>) => {
    captured.bearer = options ?? {};
    return { id: 'bearer' };
  }),
  deviceAuthorization: vi.fn((options: Record<string, any>) => {
    captured.deviceAuthorization = options;
    return { id: 'device-authorization' };
  }),
  magicLink: vi.fn(() => ({ id: 'magic-link' })),
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

import { createAuth } from '../src/lib/auth';

describe('Better Auth API-key configuration', () => {
  test('creates permanent hashed user keys with strict rate and permission defaults', () => {
    createAuth({
      AUTH_BASE_URL: 'http://localhost:3000',
      APP_ORIGIN: 'http://localhost:3000',
      BETTER_AUTH_SECRET: 'test-secret-that-is-long-enough-for-tests',
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
    expect(captured.auth?.account).toEqual({ encryptOAuthTokens: true });
    expect(captured.auth?.session).toEqual({
      cookieCache: { enabled: true, maxAge: 60 * 5 },
    });
  });

  test('enables the fixed public CLI device flow and bearer session transport', async () => {
    createAuth({
      AUTH_BASE_URL: 'http://localhost:3000',
      APP_ORIGIN: 'http://localhost:3000',
      BETTER_AUTH_SECRET: 'test-secret-that-is-long-enough-for-tests',
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
      BETTER_AUTH_SECRET: 'test-secret-that-is-long-enough-for-tests',
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
});
