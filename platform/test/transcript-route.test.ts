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
    getTranscriptWithCache: vi.fn(async () => ({ value: {
      videoId: 'abcdefghijk',
      track: {
        id: 'a.en', name: 'English', languageCode: 'en', kind: 'asr', provenance: 'asr',
        isTranslatable: true, isDefault: true,
      },
      translatedTo: { languageCode: 'hi', name: 'Hindi' },
      segments: [],
      granularity: 'word',
      text: '',
      meta: { source: 'allthingsyoutube', fetchedAt: new Date().toISOString(), partial: false, warnings: [] },
    }, cacheStatus: 'hit' as const })),
  };
});

import { app } from '../src/index';
import { getTranscriptWithCache } from '../src/lib/youtube';

describe('transcript route', () => {
  test('treats lang as the desired output language and leaves source selection to the backend', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const response = await app.request(
      '/v1/providers/youtube/videos/abcdefghijk/transcript?lang=hi',
      {},
      {} as Env,
      { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext,
    );

    expect(response.status).toBe(200);
    expect(getTranscriptWithCache).toHaveBeenCalledWith(expect.anything(), 'abcdefghijk', 'hi');
    warning.mockRestore();
  });
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
