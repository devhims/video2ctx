import { APIError, betterAuth } from 'better-auth';
import type { BetterAuthOptions } from 'better-auth';
import { createAuthMiddleware, getSessionFromCtx } from 'better-auth/api';
import { apiKey } from '@better-auth/api-key';
import { checkout, polar, portal, webhooks } from '@polar-sh/better-auth';
import { admin, bearer, deviceAuthorization, magicLink, oAuthProxy } from 'better-auth/plugins';
import type { EmailMessage } from '../types';
import { safeErrorLog } from './http';
import { queueWelcomeEmail } from './notification-delivery';
import { polarClient } from './polar-client';
import { DEFAULT_API_KEY_PERMISSIONS } from './api-key-permissions';
import {
  applyPaidOrder,
  applyRefundedOrder,
  recordCheckoutIntent,
  syncCustomerState,
  syncRevokedSubscription,
} from './billing';

export const DEVICE_AUTH_CLIENT_ID = 'video2ctx-cli';
export const DEVICE_AUTH_SCOPE = 'data:read account:access';

export function createAuthOptions(env: Env, executionCtx: { waitUntil(promise: Promise<unknown>): void }, adminUserIds: string[] = []) {
  const previewHostPattern = String(env.AUTH_PREVIEW_HOST_PATTERN ?? '').trim();
  const allowedHosts = [...new Set([
    new URL(env.AUTH_BASE_URL).host,
    new URL(env.APP_ORIGIN).host,
    ...(previewHostPattern ? [previewHostPattern] : []),
  ])];
  const trustedOrigins = [...new Set([
    env.APP_ORIGIN,
    env.AUTH_BASE_URL,
    ...(previewHostPattern ? [`https://${previewHostPattern}`] : []),
  ])];
  return {
    appName: 'video2ctx',
    baseURL: { allowedHosts, fallback: env.AUTH_BASE_URL },
    basePath: '/api/auth',
    // User deletion must run our billing, durable-state and storage cleanup.
    disabledPaths: ['/admin/remove-user'],
    secret: env.BETTER_AUTH_SECRET,
    database: env.DB,
    trustedOrigins,
    session: {
      cookieCache: {
        enabled: true,
        maxAge: 60 * 5,
      },
    },
    account: { encryptOAuthTokens: true },
    socialProviders: {
      github: {
        clientId: env.GITHUB_CLIENT_ID,
        clientSecret: env.GITHUB_CLIENT_SECRET,
      },
      google: {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        scope: ['openid', 'email', 'profile'],
      },
    },
    verification: { storeIdentifier: 'hashed' },
    hooks: { before: createAuthMiddleware(checkoutIntentHook(env)) },
    databaseHooks: {
      user: {
        create: {
          // Runs after the user row and its signup credit grant commit. The welcome
          // email is queued in the background so it never delays or fails signup.
          after: async (user) => {
            executionCtx.waitUntil(
              queueWelcomeEmail(env, { id: user.id, email: user.email, name: user.name ?? '' })
                .catch((error) => console.error({ event: 'welcome_email_queue_failed', ...safeErrorLog(error) })),
            );
          },
        },
      },
    },
    plugins: [
      oAuthProxy({
        productionURL: env.AUTH_BASE_URL,
        secret: env.OAUTH_PROXY_SECRET,
        maxAge: 60,
      }),
      admin({ adminUserIds }),
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
          const { renderMagicLinkEmail } = await import('./email-templates');
          const content = await renderMagicLinkEmail({ url });
          const message: EmailMessage = {
            type: 'magic-link',
            idempotencyKey: `magic:${await digest(url)}`,
            to: email,
            subject: 'Sign in to video2ctx',
            html: content.html,
            text: content.text,
          };
          await env.EMAIL_TASKS.send(message, { contentType: 'json' });
        },
      }),
      polar({
        client: polarClient(env),
        createCustomerOnSignUp: false,
        use: [
          checkout({
            products: [{ productId: env.POLAR_BUILDER_PRODUCT_ID, slug: 'builder' }],
            successUrl: `${env.APP_ORIGIN}/dashboard?section=settings&checkout=success`,
            returnUrl: `${env.APP_ORIGIN}/dashboard?section=settings&checkout=cancelled`,
            authenticatedUsersOnly: true,
          }),
          portal({ returnUrl: `${env.APP_ORIGIN}/dashboard?section=settings` }),
          webhooks({
            secret: env.POLAR_WEBHOOK_SECRET,
            onOrderPaid: (payload) => applyPaidOrder(env, payload),
            onOrderRefunded: (payload) => applyRefundedOrder(env, payload),
            onCustomerStateChanged: (payload) => syncCustomerState(env, payload),
            onSubscriptionRevoked: (payload) => syncRevokedSubscription(env, payload),
          }),
        ],
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

type SessionResolver = (ctx: Parameters<typeof getSessionFromCtx>[0]) => Promise<{ user: { id: string } } | null>;

/**
 * Polar checkout can create a customer before any webhook reaches us, so the
 * intent is recorded before the checkout endpoint contacts Polar. A failed write
 * aborts the checkout rather than letting a customer exist without local evidence.
 */
export function checkoutIntentHook(env: Env, resolveSession: SessionResolver = getSessionFromCtx) {
  return async (ctx: Parameters<typeof getSessionFromCtx>[0] & { path?: string }) => {
    if (!ctx.path?.startsWith('/checkout')) return;
    const session = await resolveSession(ctx);
    // The checkout plugin rejects signed-out requests itself.
    if (session?.user.id) await recordCheckoutIntent(env, session.user.id);
  };
}

export function createAuth(env: Env, executionCtx: { waitUntil(promise: Promise<unknown>): void }, adminUserIds: string[] = []) {
  return betterAuth(createAuthOptions(env, executionCtx, adminUserIds));
}

async function digest(value: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
