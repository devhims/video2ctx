import { cors } from 'hono/cors';

export const applicationCors = cors({
  origin: (origin, c) => origin === c.env.APP_ORIGIN ? origin : '',
  allowHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  exposeHeaders: [
    'X-Request-Id',
    'X-Credits-Charged',
    'X-Credits-Remaining',
    'X-Demo-Limit',
    'X-Demo-Remaining',
    'X-Demo-Reset',
  ],
  credentials: true,
});
