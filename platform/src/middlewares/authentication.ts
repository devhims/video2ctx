import type { Context, MiddlewareHandler } from 'hono';
import type { App, AppUser, AuthPrincipal } from '../types';
import { createAuth } from '../lib/auth';
import { DEFAULT_API_KEY_PERMISSIONS, hasApiKeyPermission } from '../lib/api-key-permissions';
import { ApiError, now, sha256 } from '../lib/http';

const CLI_SESSION_AUTH_ROUTES = new Set([
  '/api/auth/get-session',
  '/api/auth/sign-out',
]);

export const restrictCliSessionAuthRoutes: MiddlewareHandler<App> = async (c, next) => {
  const authorization = c.req.header('authorization')?.trim();
  const match = authorization ? /^Bearer\s+(\S+)$/i.exec(authorization) : null;
  const token = match?.[1];

  if (token && !token.startsWith('aty_') && !CLI_SESSION_AUTH_ROUTES.has(c.req.path)) {
    throw new ApiError(403, 'SESSION_REQUIRED', 'Sign in with a browser session to continue.');
  }

  await next();
};

export const establishPrincipal: MiddlewareHandler<App> = async (c, next) => {
  c.set('principal', null);
  c.set('user', null);

  try {
    const credential = suppliedCredential(c);
    if (credential?.kind === 'api-key') {
      const auth = createAuth(c.env, c.executionCtx);
      c.set('auth', auth);
      if (credential.value.length > 256) throw new ApiError(401, 'INVALID_API_KEY', 'The API key is invalid.');
      const verification = await auth.api.verifyApiKey({
        body: { key: credential.value },
      });
      if (!verification.valid || !verification.key) {
        const code = verification.error?.code ?? 'INVALID_API_KEY';
        if (code === 'RATE_LIMITED' || code === 'USAGE_EXCEEDED') {
          throw new ApiError(429, 'API_KEY_RATE_LIMITED', 'This API key has exceeded its request limit.');
        }
        if (code === 'FAILED_TO_UPDATE_API_KEY') {
          throw new ApiError(503, 'AUTH_UNAVAILABLE', 'Authentication is temporarily unavailable.');
        }
        throw new ApiError(401, 'INVALID_API_KEY', 'The API key is invalid or has been revoked.');
      }

      const user = await findUser(c, verification.key.referenceId);
      if (!user) throw new ApiError(401, 'INVALID_API_KEY', 'The API key owner no longer exists.');
      setPrincipal(c, {
        user,
        method: 'api-key',
        apiKeyId: verification.key.id,
        permissions: verification.key.permissions ?? {},
      });
      await next();
      return;
    }

    if (credential?.kind === 'cli-session') {
      const auth = createAuth(c.env, c.executionCtx);
      c.set('auth', auth);
      if (credential.value.length > 512) {
        throw new ApiError(401, 'INVALID_SESSION_TOKEN', 'The CLI session is invalid.');
      }
      const session = await auth.api.getSession({ headers: c.req.raw.headers });
      if (!session?.user) {
        throw new ApiError(401, 'INVALID_SESSION_TOKEN', 'The CLI session is invalid or has expired.');
      }
      setPrincipal(c, {
        user: { id: session.user.id, email: session.user.email, name: session.user.name },
        method: 'cli-session',
        permissions: {
          data: [...DEFAULT_API_KEY_PERMISSIONS.data],
          account: [...DEFAULT_API_KEY_PERMISSIONS.account],
        },
      });
      await next();
      return;
    }

    if (c.req.header('cookie')) {
      const auth = createAuth(c.env, c.executionCtx);
      c.set('auth', auth);
      const session = await auth.api.getSession({ headers: c.req.raw.headers });
      if (session?.user) {
        setPrincipal(c, {
          user: { id: session.user.id, email: session.user.email, name: session.user.name },
          method: 'session',
          permissions: {},
        });
        await next();
        return;
      }
    }

    const demoId = c.req.header('x-demo-user')?.trim();
    if (demoId) {
      if (String(c.env.ENVIRONMENT) === 'production') {
        throw new ApiError(401, 'DEMO_AUTH_DISABLED', 'Demo authentication is disabled in production.');
      }
      const user = await ensureDemoUser(c, demoId);
      setPrincipal(c, { user, method: 'demo', permissions: {} });
    }

    await next();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(503, 'AUTH_UNAVAILABLE', 'Authentication is temporarily unavailable.');
  }
};

export const requireDataPrincipal: MiddlewareHandler<App> = async (c, next) => {
  const principal = requirePrincipal(c);
  if (isScopedCredential(principal) && !hasApiKeyPermission(principal, 'data', 'read')) {
    throw permissionError(principal, 'This credential cannot read data.');
  }
  await next();
};

export const requireAccountPrincipal: MiddlewareHandler<App> = async (c, next) => {
  const principal = requirePrincipal(c);
  if (isScopedCredential(principal) && !hasApiKeyPermission(principal, 'account', 'access')) {
    throw permissionError(principal, 'This credential cannot access account data.');
  }
  await next();
};

export const requireSessionPrincipal: MiddlewareHandler<App> = async (c, next) => {
  const principal = requirePrincipal(c);
  if (principal.method === 'api-key' || principal.method === 'cli-session') {
    throw new ApiError(403, 'SESSION_REQUIRED', 'Sign in with a browser session to continue.');
  }
  await next();
};

export function requirePrincipal(c: Context<App>): AuthPrincipal {
  const principal = c.get('principal');
  if (!principal) throw new ApiError(401, 'AUTH_REQUIRED', 'Sign in or provide an API key to continue.');
  return principal;
}

export function requireUser(c: Context<App>): AppUser {
  return requirePrincipal(c).user;
}

function setPrincipal(c: Context<App>, principal: AuthPrincipal): void {
  c.set('principal', principal);
  c.set('user', principal.user);
}

type SuppliedCredential = {
  kind: 'api-key' | 'cli-session';
  value: string;
};

function suppliedCredential(c: Context<App>): SuppliedCredential | undefined {
  const rawLegacyKey = c.req.header('x-api-key');
  const rawAuthorization = c.req.header('authorization');
  const legacyKey = rawLegacyKey?.trim() || undefined;
  const authorization = rawAuthorization?.trim();
  let bearerCredential: string | undefined;

  if (rawAuthorization !== undefined) {
    const match = /^Bearer\s+(\S+)$/i.exec(authorization ?? '');
    if (!match) {
      throw new ApiError(401, 'INVALID_AUTHORIZATION', 'Use Authorization: Bearer <credential>.');
    }
    bearerCredential = match[1];
  }

  if (rawLegacyKey !== undefined && !legacyKey) {
    throw new ApiError(401, 'INVALID_API_KEY', 'The API key is invalid.');
  }

  if (legacyKey && bearerCredential && legacyKey !== bearerCredential) {
    throw new ApiError(401, 'CONFLICTING_API_KEY_CREDENTIALS', 'Supply one API key credential per request.');
  }

  if (legacyKey && !legacyKey.startsWith('aty_')) {
    throw new ApiError(401, 'INVALID_API_KEY', 'The API key is invalid.');
  }

  const value = bearerCredential ?? legacyKey;
  if (!value) return undefined;
  return { kind: value.startsWith('aty_') ? 'api-key' : 'cli-session', value };
}

function isScopedCredential(principal: AuthPrincipal): boolean {
  return principal.method === 'api-key' || principal.method === 'cli-session';
}

function permissionError(principal: AuthPrincipal, message: string): ApiError {
  return principal.method === 'api-key'
    ? new ApiError(403, 'API_KEY_PERMISSION_REQUIRED', message)
    : new ApiError(403, 'CLI_SESSION_PERMISSION_REQUIRED', message);
}

async function findUser(c: Context<App>, userId: string): Promise<AppUser | null> {
  return c.env.DB.prepare('SELECT id,email,name FROM user WHERE id=?')
    .bind(userId)
    .first<AppUser>();
}

async function ensureDemoUser(c: Context<App>, demoId: string): Promise<AppUser> {
  const id = `demo-${(await sha256(demoId)).slice(0, 24)}`;
  const timestamp = now();
  await c.env.DB.prepare(
    `INSERT OR IGNORE INTO user (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,1,?,?)`
  ).bind(id, 'Demo Researcher', `${id}@example.test`, timestamp, timestamp).run();
  return { id, name: 'Demo Researcher', email: `${id}@example.test` };
}
