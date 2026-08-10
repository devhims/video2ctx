const captured = vi.hoisted(() => ({
  apiKey: undefined as Record<string, any> | undefined,
  auth: undefined as Record<string, any> | undefined,
}));

vi.mock('@better-auth/api-key', () => ({
  apiKey: vi.fn((options: Record<string, any>) => {
    captured.apiKey = options;
    return { id: 'api-key' };
  }),
}));
vi.mock('better-auth', () => ({ betterAuth: vi.fn((options) => {
  captured.auth = options;
  return { options };
}) }));
vi.mock('better-auth/plugins', () => ({ magicLink: vi.fn(() => ({ id: 'magic-link' })) }));

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
});
