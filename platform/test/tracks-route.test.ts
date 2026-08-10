vi.mock('cloudflare:workers', () => ({ WorkflowEntrypoint: class {}, DurableObject: class {} }));

vi.mock('../src/middlewares/authentication', () => routeAuthenticationMock());
vi.mock('../src/lib/metering', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/metering')>(),
  meterOperation: vi.fn(async (_c, _options, work) => (await work()).value),
}));

vi.mock('../src/lib/youtube', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/lib/youtube')>();
  return {
    ...original,
    getCaptionTracks: vi.fn(async () => ({
      tracks: [],
      sourceTracks: [],
      translationLanguages: [],
      autoTranslationTargets: [],
      meta: { source: 'allthingsyoutube', fetchedAt: '2026-08-06T00:00:00.000Z', partial: false, warnings: [] },
    })),
  };
});

function routeAuthenticationMock() {
  const user = { id: 'test-user', email: 'test@example.com', name: 'Test User' };
  const principal = { user, method: 'session' as const, permissions: {} };
  return {
    establishPrincipal: async (c: any, next: () => Promise<void>) => {
      c.set('principal', principal); c.set('user', user); await next();
    },
    requireAccountPrincipal: async (_c: any, next: () => Promise<void>) => next(),
    requireDataPrincipal: async (_c: any, next: () => Promise<void>) => next(),
    requireSessionPrincipal: async (_c: any, next: () => Promise<void>) => next(),
    requirePrincipal: () => principal,
    requireUser: () => user,
  };
}

import { app } from '../src/index';
import { getCaptionTracks } from '../src/lib/youtube';

const executionContext = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;

describe('tracks route', () => {
  test('returns transcript track metadata from the canonical route', async () => {
    const response = await app.request(
      '/v1/providers/youtube/videos/abcdefghijk/tracks',
      {},
      {} as Env,
      executionContext,
    );

    expect(response.status).toBe(200);
    expect(getCaptionTracks).toHaveBeenCalledWith(expect.anything(), 'abcdefghijk');
    await expect(response.json()).resolves.toMatchObject({ sourceTracks: [], autoTranslationTargets: [] });
  });

  test('does not expose the former captions route', async () => {
    const response = await app.request(
      '/v1/providers/youtube/videos/abcdefghijk/captions',
      {},
      {} as Env,
      executionContext,
    );

    expect(response.status).toBe(404);
  });
});
