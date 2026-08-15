import { APIError, betterAuth } from 'better-auth';
import type { BetterAuthOptions } from 'better-auth';
import { apiKey } from '@better-auth/api-key';
import { bearer, deviceAuthorization, magicLink } from 'better-auth/plugins';
import type { EmailMessage } from '../types';
import { escapeHtml } from './http';
import { DEFAULT_API_KEY_PERMISSIONS } from './api-key-permissions';

export const DEVICE_AUTH_CLIENT_ID = 'video2ctx-cli';
export const DEVICE_AUTH_SCOPE = 'data:read account:access';

export function createAuthOptions(env: Env, executionCtx: { waitUntil(promise: Promise<unknown>): void }) {
  return {
    appName: 'video2ctx',
    baseURL: env.AUTH_BASE_URL,
    basePath: '/api/auth',
    secret: env.BETTER_AUTH_SECRET,
    database: env.DB,
    trustedOrigins: [env.APP_ORIGIN],
    session: {
      cookieCache: {
        enabled: true,
        maxAge: 60 * 5,
      },
    },
    account: { encryptOAuthTokens: true },
    socialProviders: {
      google: {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        scope: ['openid', 'email', 'profile'],
      },
    },
    verification: { storeIdentifier: 'hashed' },
    plugins: [
      apiKey({
        apiKeyHeaders: 'x-api-key',
        defaultPrefix: 'aty_',
        defaultKeyLength: 64,
        requireName: true,
        storage: 'database',
        references: 'user',
        enableSessionForAPIKeys: false,
        deferUpdates: false,
        keyExpiration: {
          defaultExpiresIn: null,
          disableCustomExpiresTime: true,
        },
        rateLimit: {
          enabled: true,
          timeWindow: 60_000,
          maxRequests: 60,
        },
        permissions: {
          defaultPermissions: DEFAULT_API_KEY_PERMISSIONS,
        },
      }),
      bearer(),
      deviceAuthorization({
        verificationUri: '/device',
        expiresIn: '15m',
        interval: '5s',
        validateClient: async (clientId) => clientId === DEVICE_AUTH_CLIENT_ID,
        onDeviceAuthRequest: async (_clientId, scope) => {
          if (scope !== DEVICE_AUTH_SCOPE) {
            throw new APIError('BAD_REQUEST', {
              error: 'invalid_request',
              error_description: 'Unsupported scope',
            });
          }
        },
      }),
      magicLink({
        expiresIn: 900,
        storeToken: 'hashed',
        sendMagicLink: async ({ email, url }) => {
          const safeUrl = escapeHtml(url);
          const message: EmailMessage = {
            type: 'magic-link',
            idempotencyKey: `magic:${await digest(url)}`,
            to: email,
            subject: 'Sign in to video2ctx',
            html: `<p>Use this secure link to sign in:</p><p><a href="${safeUrl}">Sign in</a></p><p>This link expires in 15 minutes and can be used once.</p>`,
            text: `Sign in to video2ctx: ${url}\n\nThis link expires in 15 minutes and can be used once.`,
          };
          await env.EMAIL_TASKS.send(message, { contentType: 'json' });
        },
      }),
    ],
    advanced: {
      database: { generateId: () => crypto.randomUUID() },
      backgroundTasks: {
        handler: (promise) => executionCtx.waitUntil(promise),
      },
    },
  } satisfies BetterAuthOptions;
}

export function createAuth(env: Env, executionCtx: { waitUntil(promise: Promise<unknown>): void }) {
  return betterAuth(createAuthOptions(env, executionCtx));
}

async function digest(value: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
