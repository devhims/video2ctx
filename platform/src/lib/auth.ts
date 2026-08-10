import { betterAuth } from 'better-auth';
import { apiKey } from '@better-auth/api-key';
import { magicLink } from 'better-auth/plugins';
import type { EmailMessage } from '../types';
import { escapeHtml } from './http';
import { DEFAULT_API_KEY_PERMISSIONS } from './api-key-permissions';

export function createAuth(env: Env, executionCtx: { waitUntil(promise: Promise<unknown>): void }) {
  return betterAuth({
    appName: 'all-things-youtube',
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
      magicLink({
        expiresIn: 900,
        storeToken: 'hashed',
        sendMagicLink: async ({ email, url }) => {
          const safeUrl = escapeHtml(url);
          const message: EmailMessage = {
            type: 'magic-link',
            idempotencyKey: `magic:${await digest(url)}`,
            to: email,
            subject: 'Sign in to all-things-youtube',
            html: `<p>Use this secure link to sign in:</p><p><a href="${safeUrl}">Sign in</a></p><p>This link expires in 15 minutes and can be used once.</p>`,
            text: `Sign in to all-things-youtube: ${url}\n\nThis link expires in 15 minutes and can be used once.`,
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
  });
}

async function digest(value: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
