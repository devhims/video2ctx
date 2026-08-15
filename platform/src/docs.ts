import { Scalar } from '@scalar/hono-api-reference';
import { Hono } from 'hono';
import { video2ctxFavicon } from './generated/brand';
import { openApiDocument } from './openapi';

export const documentationApp = new Hono()
  .get('/openapi.json', (c) => {
    const forwardedPrefix = c.req.header('x-forwarded-prefix');
    const basePath = forwardedPrefix?.startsWith('/') ? forwardedPrefix.replace(/\/$/, '') : '/';
    return c.json({
      ...openApiDocument,
      servers: [{ url: basePath, description: basePath === '/' ? 'Direct platform Worker' : 'Next.js platform proxy' }],
    });
  })
  .get('/docs', Scalar({
    url: './openapi.json',
    pageTitle: 'video2ctx API Reference',
    favicon: video2ctxFavicon,
  }));
