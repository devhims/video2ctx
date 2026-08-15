const captured = vi.hoisted(() => ({
  apiKey: undefined as Record<string, any> | undefined,
  auth: undefined as Record<string, any> | undefined,
  bearer: undefined as Record<string, any> | undefined,
  deviceAuthorization: undefined as Record<string, any> | undefined,
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

import { createAuth } from '../src/lib/auth';

describe('Better Auth API-key configuration', () => {
  test('creates permanent hashed user keys with strict rate and permission defaults', () => {
    createAuth({
      AUTH_BASE_URL: 'http://localhost:3000',
      APP_ORIGIN: 'http://localhost:3000',
      BETTER_AUTH_SECRET: 'test-secret-that-is-long-enough-for-tests',
      GOOGLE_CLIENT_ID: 'google-client',
      GOOGLE_CLIENT_SECRET: 'google-secret',
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
    ]));
  });
});
