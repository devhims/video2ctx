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
      info: { title: 'all-things-youtube API' },
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
    expect(html).toContain('all-things-youtube API Reference');
    expect(html).toContain('./openapi.json');
  });

  test('documents every concrete HTTP route declared by the Hono app', () => {
    const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    const routePattern = /app\.(get|post|put|patch|delete)\(\s*['"]([^'"]+)['"]/g;
    const declared = [...source.matchAll(routePattern)].map(([, method, route]) => ({
      method: method!,
      path: route!.replace(/:([A-Za-z0-9_]+)/g, '{$1}'),
    }));
    const paths = openApiDocument.paths as Record<string, Record<string, unknown>>;

    expect(source).toContain("app.route('/', documentationApp)");
    expect(declared.length).toBeGreaterThan(35);
    for (const route of declared) {
      expect(paths[route.path]?.[route.method], `${route.method.toUpperCase()} ${route.path}`).toBeDefined();
    }
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
      expect(reference).toMatch(/^#\/components\/(schemas|responses)\/[A-Za-z0-9]+$/);
      const parts = reference.slice(2).split('/');
      let target: unknown = openApiDocument;
      for (const part of parts) target = (target as Record<string, unknown>)[part];
      expect(target, reference).toBeDefined();
    }
  });

  test('documents categorized and paginated YouTube search responses', () => {
    const searchOperation = (openApiDocument.paths as Record<string, Record<string, any>>)
      ['/v1/search']!.get;
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
    const tracksOperation = paths['/v1/videos/{id}/tracks']!.get;
    const transcriptOperation = (openApiDocument.paths as Record<string, Record<string, any>>)
      ['/v1/videos/{id}/transcript']!.get;
    const parameterNames = transcriptOperation.parameters.map((parameter: { name: string }) => parameter.name);

    expect(tracksOperation.operationId).toBe('getVideoTracks');
    expect(tracksOperation.deprecated).not.toBe(true);
    expect(paths['/v1/videos/{id}/captions']).toBeUndefined();
    expect(parameterNames).toContain('lang');
    expect(parameterNames).not.toContain('translateTo');
    expect(parameterNames).not.toContain('language');
    expect(schemas.CaptionTrackList.required).toEqual(expect.arrayContaining([
      'tracks', 'sourceTracks', 'translationLanguages', 'autoTranslationTargets',
    ]));
    expect(schemas.Transcript.properties.translatedTo.$ref).toBe('#/components/schemas/TranslationLanguage');
    expect(schemas.CommentResponse.properties.totalCount).toMatchObject({ type: 'integer', minimum: 0 });
    expect(schemas.CommentResponse.properties.estimatedTotal).toBeUndefined();
    expect(schemas.Video.required).toBeUndefined();
    expect(schemas.Video.allOf[1].required).toEqual(['keywords', 'availability', 'meta']);
    expect(schemas.Video.allOf[1].properties).not.toHaveProperty('captionTracks');
    expect(schemas.Video.allOf[1].properties).not.toHaveProperty('translationLanguages');
    expect(schemas.Video.allOf[1].properties).not.toHaveProperty('media');
    expect(schemas.Video.allOf[1].properties).not.toHaveProperty('storyboards');
    expect(schemas.Video.allOf[1].properties).not.toHaveProperty('endscreen');
    expect(schemas.SourceMetadata.properties.source).toEqual({
      type: 'string', const: 'allthingsyoutube',
    });
    expect(schemas.Channel.required).toEqual([
      'type', 'id', 'name', 'thumbnails', 'url', 'about', 'meta',
    ]);
    expect(schemas.Channel.properties).not.toHaveProperty('videos');
    expect(schemas.Channel.properties).not.toHaveProperty('playlists');
    expect(schemas.ChannelAbout.required).toEqual(['links', 'moreInfo']);
    expect(schemas.ChannelMoreInfo.properties.businessEmailAvailable.type).toBe('boolean');
    expect(schemas.ChannelVideos.required).toEqual(['channelId', 'sort', 'videos', 'meta']);
    expect(schemas.ChannelPlaylists.required).toEqual(['channelId', 'sort', 'playlists', 'meta']);
    expect(paths['/v1/channels/{id}/videos']!.get.parameters.map((parameter: { name: string }) => parameter.name))
      .toContain('continuation');
    expect(paths['/v1/channels/{id}/playlists']!.get.parameters.map((parameter: { name: string }) => parameter.name))
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
