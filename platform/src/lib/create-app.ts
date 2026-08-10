import { Hono } from 'hono';
import type { App } from '../types';
import { requestContext } from '../middlewares';
import { jsonError } from './http';

export function createRouter(): Hono<App> {
  return new Hono<App>();
}

export default function createApp(): Hono<App> {
  const app = createRouter();

  app.use('*', requestContext);
  app.notFound((c) => c.json({
    error: { code: 'NOT_FOUND', message: 'Route not found.', requestId: c.get('requestId') },
  }, 404));
  app.onError((error, c) => jsonError(c, error));

  return app;
}
