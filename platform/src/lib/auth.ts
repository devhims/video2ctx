import { betterAuth } from 'better-auth';
import { magicLink } from 'better-auth/plugins';
import type { EmailMessage } from '../types';
import { escapeHtml } from './http';

export function createAuth(env: Env, executionCtx: { waitUntil(promise: Promise<unknown>): void }) {
  return betterAuth({
    appName: 'YouTube Intelligence',
    baseURL: env.AUTH_BASE_URL,
    basePath: '/api/auth',
    secret: env.BETTER_AUTH_SECRET,
    database: env.DB,
    trustedOrigins: [env.APP_ORIGIN],
    socialProviders: {
      google: {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        scope: ['openid', 'email', 'profile'],
      },
    },
    verification: { storeIdentifier: 'hashed' },
    plugins: [
      magicLink({
        expiresIn: 900,
        storeToken: 'hashed',
        sendMagicLink: async ({ email, url }) => {
          const safeUrl = escapeHtml(url);
          const message: EmailMessage = {
            type: 'magic-link',
            idempotencyKey: `magic:${await digest(url)}`,
            to: email,
            subject: 'Sign in to YouTube Intelligence',
            html: `<p>Use this secure link to sign in:</p><p><a href="${safeUrl}">Sign in</a></p><p>This link expires in 15 minutes and can be used once.</p>`,
            text: `Sign in to YouTube Intelligence: ${url}\n\nThis link expires in 15 minutes and can be used once.`,
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
