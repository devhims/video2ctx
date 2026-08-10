import { Scalar } from '@scalar/hono-api-reference';
import { Hono } from 'hono';
import { openApiDocument } from './openapi';

const video2ctxFavicon =
  'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 512 512%22%3E%3Crect x=%2232%22 y=%2232%22 width=%22448%22 height=%22448%22 rx=%22144%22 fill=%22%23e94b3d%22/%3E%3Cpath d=%22M160 137h-21c-22 0-40 18-40 40v158c0 22 18 40 40 40h21M352 137h21c22 0 40 18 40 40v158c0 22-18 40-40 40h-21%22 fill=%22none%22 stroke=%22white%22 stroke-width=%2225%22 stroke-linecap=%22round%22/%3E%3Cpath d=%22M197 182c0-11 12-17 21-12l93 56c9 5 9 18 0 23l-93 56c-9 5-21-1-21-12Z%22 fill=%22white%22/%3E%3Cpath d=%22M208 337h96M224 369h64%22 fill=%22none%22 stroke=%22white%22 stroke-width=%2218%22 stroke-linecap=%22round%22/%3E%3C/svg%3E';

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
    pageTitle: 'Video2ctx API Reference',
    favicon: video2ctxFavicon,
  }));
