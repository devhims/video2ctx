import type { MiddlewareHandler } from 'hono';
import type { App } from '../types';
import { createAuth } from '../lib/auth';
import { requireAdminBrowserRequest, requireAdminSession } from '../lib/admin-access';

export const betterAuthContext: MiddlewareHandler<App> = async (c, next) => {
  c.header('Cache-Control', 'no-store');
  c.set('auth', createAuth(c.env, c.executionCtx));
  c.set('principal', null);
  c.set('user', null);
  if (c.req.path.startsWith('/api/auth/admin/')) {
    requireAdminBrowserRequest(c);
    // An impersonated user must still be able to return to the operator session.
    if (c.req.path !== '/api/auth/admin/stop-impersonating') {
      const adminUserId = await requireAdminSession(c);
      // Grant plugin access only to the operator verified for this request.
      c.set('auth', createAuth(c.env, c.executionCtx, [adminUserId]));
    }
  }
  await next();
};
