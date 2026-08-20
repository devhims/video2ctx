import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { documentationApp } from '../src/docs';
import { openApiDocument } from '../src/openapi';

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head']);
const mountedApp = new Hono().route('/', documentationApp);

describe('OpenAPI and Scalar documentation', () => {
  test('serves the OpenAPI 3.1 document', async () => {
    const response = await mountedApp.request('/openapi.json');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    await expect(response.json()).resolves.toMatchObject({
      openapi: '3.1.0',
      info: {
        title: 'video2ctx API',
        license: {
          name: 'Apache License 2.0',
          identifier: 'Apache-2.0',
        },
      },
      servers: [{ url: '/' }],
    });
  });

  test('publishes the Next.js proxy base path when forwarded by the web app', async () => {
    const response = await mountedApp.request('/openapi.json', {
      headers: { 'x-forwarded-prefix': '/api/platform' },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      servers: [{ url: '/api/platform' }],
    });
  });

  test('serves Scalar configured to load the relative contract URL', async () => {
    const response = await mountedApp.request('/docs');
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(html).toContain('video2ctx API Reference');
    expect(html).toContain('./openapi.json');
    expect(html).toContain('data:image/png;base64');
    expect(html).not.toContain('data:image/svg+xml');
  });

  test('documents every concrete HTTP route declared by the Hono app', () => {
    const files = [
      ['indexRoutes', '../src/routes/index.route.ts', ''],
      ['dataRoutes', '../src/routes/data/data.index.ts', '/v1'],
      ['publicRoutes', '../src/routes/public/public.index.ts', '/v1'],
      ['sessionRoutes', '../src/routes/session/session.index.ts', '/v1'],
    ] as const;
    const declared = files.flatMap(([router, file, prefix]) => {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      const routePattern = new RegExp(`${router}\\.(get|post|put|patch|delete)\\(\\s*['\"]([^'\"]+)['\"]`, 'g');
      return [...source.matchAll(routePattern)].map(([, method, route]) => ({
        method: method!,
        path: `${prefix}${route}`.replace(/:([A-Za-z0-9_]+)/g, '{$1}'),
      }));
    });
    const paths = openApiDocument.paths as Record<string, Record<string, unknown>>;

    const source = readFileSync(new URL('../src/app.ts', import.meta.url), 'utf8');
    expect(source).toContain("app.route('/', documentationApp)");
    expect(declared.length).toBeGreaterThan(35);
    for (const route of declared) {
      expect(paths[route.path]?.[route.method], `${route.method.toUpperCase()} ${route.path}`).toBeDefined();
    }
  });

  test('classifies route groups with explicit principal and session guards', () => {
    const dataSource = readFileSync(new URL('../src/routes/data/data.index.ts', import.meta.url), 'utf8');
    const sessionSource = readFileSync(new URL('../src/routes/session/session.index.ts', import.meta.url), 'utf8');
    const publicSource = readFileSync(new URL('../src/routes/public/public.index.ts', import.meta.url), 'utf8');

    expect(dataSource).toContain('DATA_ROUTE_PATTERNS');
    expect(dataSource).toContain('dataRoutes.use(path, requireDataPrincipal)');
    expect(sessionSource).toContain('ACCOUNT_ROUTE_PATTERNS');
    expect(sessionSource).toContain('SESSION_ONLY_ROUTE_PATTERNS');
    expect(sessionSource).toContain('sessionRoutes.use(path, requireAccountPrincipal)');
    expect(sessionSource).toContain('sessionRoutes.use(path, requireSessionPrincipal)');
    expect(dataSource).not.toContain("dataRoutes.use('*'");
    expect(sessionSource).not.toContain("sessionRoutes.use('*'");
    expect(publicSource).not.toContain('requireDataPrincipal');
    expect(publicSource).not.toContain('requireSessionPrincipal');
  });

  test('uses unique operation IDs and resolvable local component references', () => {
    const paths = openApiDocument.paths as Record<string, Record<string, unknown>>;
    const operationIds = Object.values(paths).flatMap((pathItem) =>
      Object.entries(pathItem)
        .filter(([method]) => HTTP_METHODS.has(method))
        .map(([, operation]) => (operation as { operationId?: string }).operationId),
    );
    expect(operationIds.every(Boolean)).toBe(true);
    expect(new Set(operationIds).size).toBe(operationIds.length);

    const references: string[] = [];
    walk(openApiDocument, (value) => {
      if ('$ref' in value && typeof value.$ref === 'string') references.push(value.$ref);
    });
    expect(references.length).toBeGreaterThan(30);
    for (const reference of references) {
      expect(reference).toMatch(/^#\/components\/(schemas|responses|headers)\/[A-Za-z0-9]+$/);
      const parts = reference.slice(2).split('/');
      let target: unknown = openApiDocument;
      for (const part of parts) target = (target as Record<string, unknown>)[part];
      expect(target, reference).toBeDefined();
    }
  });

  test('documents API-key and CLI-session authentication with credit response headers for data routes', () => {
    const components = openApiDocument.components as Record<string, any>;
    const paths = openApiDocument.paths as Record<string, Record<string, any>>;
    const dataOperations = [
      paths['/v1/search']!.get,
      paths['/v1/providers/{provider}/browse']!.get,
      paths['/v1/providers/{provider}/videos/{id}']!.get,
      paths['/v1/usage']!.get,
      paths['/v1/answers']!.post,
    ];

    expect(components.securitySchemes.apiKey).toMatchObject({
      type: 'apiKey', in: 'header', name: 'X-API-Key',
    });
    expect(components.securitySchemes.bearerApiKey).toMatchObject({
      type: 'http', scheme: 'bearer', bearerFormat: 'API key',
    });
    expect(components.securitySchemes.cliSession).toMatchObject({
      type: 'http', scheme: 'bearer', bearerFormat: 'CLI session',
    });
    for (const operation of dataOperations) {
      expect(operation.security).toContainEqual({ bearerApiKey: [] });
      expect(operation.security).toContainEqual({ cliSession: [] });
      expect(operation.security).toContainEqual({ apiKey: [] });
      expect(operation.responses['200'].headers).toMatchObject({
        'X-Credits-Charged': { $ref: '#/components/headers/CreditsCharged' },
        'X-Credits-Remaining': { $ref: '#/components/headers/CreditsRemaining' },
      });
      expect(operation.responses['402']).toEqual({ $ref: '#/components/responses/InsufficientCredits' });
    }
    expect(paths['/v1/projects']!.get.security).toContainEqual({ bearerApiKey: [] });
    expect(paths['/v1/billing']!.get.security).not.toContainEqual({ bearerApiKey: [] });
    expect(paths['/v1/account']!.delete.security).not.toContainEqual({ bearerApiKey: [] });
    expect(paths['/v1/account']!.delete.security).not.toContainEqual({ cliSession: [] });
    expect(paths['/v1/account']!.get.security).toContainEqual({ cliSession: [] });
  });

  test('documents the device authorization protocol without making browser approval a bearer operation', () => {
    const paths = openApiDocument.paths as Record<string, Record<string, any>>;

    expect(paths['/api/auth/device/code']!.post.security).toEqual([]);
    expect(paths['/api/auth/device/token']!.post.security).toEqual([]);
    expect(paths['/api/auth/device']!.get.security).toEqual([{ sessionCookie: [] }]);
    expect(paths['/api/auth/device/approve']!.post.security).toEqual([{ sessionCookie: [] }]);
    expect(paths['/api/auth/device/deny']!.post.security).toEqual([{ sessionCookie: [] }]);
    expect(paths['/api/auth/sign-out']!.post.security).toContainEqual({ cliSession: [] });
  });

  test('documents categorized and paginated provider search responses', () => {
    const searchOperation = (openApiDocument.paths as Record<string, Record<string, any>>)
      ['/v1/providers/{provider}/search']!.get;
    const parameterNames = searchOperation.parameters.map((parameter: { name: string }) => parameter.name);
    const searchSchema = (openApiDocument.components.schemas as Record<string, any>).SearchResponse;

    expect(parameterNames).toContain('continuation');
    expect(searchSchema.required).toEqual(expect.arrayContaining([
      'query', 'results', 'meta',
    ]));
    expect(searchSchema.properties.results.items.$ref).toBe('#/components/schemas/SearchResult');
    expect(searchSchema.properties).not.toHaveProperty('videos');
    expect(searchSchema.properties).not.toHaveProperty('channels');
    expect(searchSchema.properties).not.toHaveProperty('playlists');
  });

  test('documents tracks and transcript auto-translation', () => {
    const schemas = openApiDocument.components.schemas as Record<string, any>;
    const paths = openApiDocument.paths as Record<string, Record<string, any>>;
    const tracksOperation = paths['/v1/providers/{provider}/videos/{id}/tracks']!.get;
    const transcriptOperation = (openApiDocument.paths as Record<string, Record<string, any>>)
      ['/v1/providers/{provider}/videos/{id}/transcript']!.get;
    const parameterNames = transcriptOperation.parameters.map((parameter: { name: string }) => parameter.name);

    expect(tracksOperation.operationId).toBe('getVideoTracks');
    expect(tracksOperation.deprecated).not.toBe(true);
    expect(paths['/v1/providers/{provider}/videos/{id}/captions']).toBeUndefined();
    expect(parameterNames).toContain('lang');
    expect(parameterNames).toContain('format');
    expect(parameterNames).not.toContain('translateTo');
    expect(parameterNames).not.toContain('language');
    expect(schemas.CaptionTrackList.required).toEqual(expect.arrayContaining([
      'tracks', 'sourceTracks', 'translationLanguages', 'autoTranslationTargets',
    ]));
    expect(schemas.Transcript.properties.translatedTo.$ref).toBe('#/components/schemas/TranslationLanguage');
    expect(schemas.TranscriptText.required).toEqual(['videoId', 'track', 'text', 'meta']);
    expect(schemas.TranscriptSegments.properties.segments.items.$ref).toBe('#/components/schemas/TranscriptSegment');
    expect(schemas.CommentResponse.properties.totalCount).toMatchObject({ type: 'integer', minimum: 0 });
    expect(schemas.CommentResponse.properties.estimatedTotal).toBeUndefined();
    expect(schemas.Video.required).toBeUndefined();
    expect(schemas.Video.allOf[1].required).toEqual(['keywords', 'availability', 'meta']);
    expect(schemas.Video.allOf[1].properties).not.toHaveProperty('captionTracks');
    expect(schemas.Video.allOf[1].properties).not.toHaveProperty('translationLanguages');
    expect(schemas.Video.allOf[1].properties).not.toHaveProperty('media');
    expect(schemas.Video.allOf[1].properties).not.toHaveProperty('storyboards');
    expect(schemas.Video.allOf[1].properties).not.toHaveProperty('endscreen');
    expect(schemas.SourceMetadata.required).toContain('provider');
    expect(schemas.SourceMetadata.properties.provider.enum).toEqual(['youtube']);
    expect(schemas.Channel.required).toEqual([
      'type', 'id', 'name', 'thumbnails', 'url', 'about', 'meta',
    ]);
    expect(schemas.Channel.properties).not.toHaveProperty('videos');
    expect(schemas.Channel.properties).not.toHaveProperty('playlists');
    expect(schemas.ChannelAbout.required).toEqual(['links', 'moreInfo']);
    expect(schemas.ChannelMoreInfo.properties.businessEmailAvailable.type).toBe('boolean');
    expect(schemas.ChannelVideos.required).toEqual(['channelId', 'sort', 'videos', 'meta']);
    expect(schemas.ChannelPlaylists.required).toEqual(['channelId', 'sort', 'playlists', 'meta']);
    expect(paths['/v1/providers/{provider}/channels/{id}/videos']!.get.parameters.map((parameter: { name: string }) => parameter.name))
      .toContain('continuation');
    expect(paths['/v1/providers/{provider}/channels/{id}/playlists']!.get.parameters.map((parameter: { name: string }) => parameter.name))
      .toContain('continuation');
  });

  test('classifies the universal input resolver as an internal UI helper', () => {
    const operation = (openApiDocument.paths as Record<string, Record<string, any>>)
      ['/v1/resolve']!.post;

    expect(operation.tags).toEqual(['UI Helpers']);
    expect(operation['x-internal']).toBe(true);
    expect(operation.description).toContain('not a primary public consumer API');
  });
});

function walk(value: unknown, visit: (record: Record<string, unknown>) => void): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
    return;
  }
  const record = value as Record<string, unknown>;
  visit(record);
  for (const item of Object.values(record)) walk(item, visit);
}
