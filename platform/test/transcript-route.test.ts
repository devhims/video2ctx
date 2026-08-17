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
      segments: [{
        startMs: 0,
        durationMs: 1000,
        endMs: 1000,
        text: 'Hello world',
        words: [{ text: 'Hello', startMs: 0, offsetMs: 0 }],
      }],
      granularity: 'word',
      text: 'Hello world',
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

  test('returns compact text when requested without changing the cached upstream shape', async () => {
    const response = await app.request(
      '/v1/providers/youtube/videos/abcdefghijk/transcript?format=text',
      {},
      {} as Env,
      { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext,
    );

    expect(response.status).toBe(200);
    const payload = await response.json() as Record<string, unknown>;
    expect(payload).toMatchObject({
      videoId: 'abcdefghijk',
      text: 'Hello world',
      meta: { partial: false },
    });
    expect(payload).not.toHaveProperty('segments');
    expect(payload).not.toHaveProperty('granularity');
    expect(getTranscriptWithCache).toHaveBeenLastCalledWith(expect.anything(), 'abcdefghijk', undefined);
  });

  test('rejects an unsupported transcript format before loading data', async () => {
    const calls = vi.mocked(getTranscriptWithCache).mock.calls.length;
    const response = await app.request(
      '/v1/providers/youtube/videos/abcdefghijk/transcript?format=srt',
      {},
      {} as Env,
      { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext,
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'INVALID_TRANSCRIPT_FORMAT' },
    });
    expect(getTranscriptWithCache).toHaveBeenCalledTimes(calls);
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
