import type { Context } from 'hono';
import type { App } from '../types';
import { createAuth } from './auth';
import { ApiError } from './http';

/** Administrative operations always use a live browser session, never cached roles. */
export function requireAdminBrowserRequest(c: Context<App>): void {
  if (c.req.header('authorization') || c.req.header('x-api-key') || c.req.header('x-demo-user')) {
    throw new ApiError(403, 'SESSION_REQUIRED', 'Sign in with a browser session to continue.');
  }
  if (!c.req.header('cookie')) throw new ApiError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
}

export async function requireAdminSession(c: Context<App>): Promise<string> {
  requireAdminBrowserRequest(c);
  const auth = c.get('auth') ?? createAuth(c.env, c.executionCtx);
  let session;
  try {
    session = await auth.api.getSession({ headers: c.req.raw.headers, query: { disableCookieCache: true, disableRefresh: true } });
  } catch {
    throw new ApiError(503, 'AUTH_UNAVAILABLE', 'Admin access could not be verified.');
  }
  if (!session) throw new ApiError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
  const { user } = session;
  const banned = user.banned && (!user.banExpires || new Date(user.banExpires).getTime() > Date.now());
  if (!user.emailVerified || banned || session.session.impersonatedBy) {
    throw new ApiError(403, 'ADMIN_REQUIRED', 'Admin access required.');
  }
  const hasAdminRole = user.role?.split(',').map(role => role.trim()).includes('admin');
  const existingOperators = String(c.env.ADMIN_EMAILS_SECRET ?? '').split(',').map(email => email.trim().toLowerCase()).filter(Boolean);
  if (!hasAdminRole && !existingOperators.includes(user.email.trim().toLowerCase())) {
    throw new ApiError(403, 'ADMIN_REQUIRED', 'Admin access required.');
  }
  return user.id;
}

export function requireAdminMutationOrigin(c: Context<App>): void {
  if (c.req.header('origin') !== c.env.APP_ORIGIN) {
    throw new ApiError(403, 'INVALID_ORIGIN', 'Use the dashboard to manage Agent access.');
  }
}
