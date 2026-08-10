import type { MiddlewareHandler } from 'hono';
import type { App } from '../types';
import { createAuth } from '../lib/auth';

export const betterAuthContext: MiddlewareHandler<App> = async (c, next) => {
  c.header('Cache-Control', 'no-store');
  c.set('auth', createAuth(c.env, c.executionCtx));
  c.set('principal', null);
  c.set('user', null);
  await next();
};
