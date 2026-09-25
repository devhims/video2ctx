vi.mock('cloudflare:workers', () => ({ WorkflowEntrypoint: class {}, DurableObject: class {} }));

vi.mock('../src/middlewares/authentication', () => {
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
});

vi.mock('../src/lib/metering', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/metering')>(),
  meterOperation: vi.fn(async (_c, _options, work) => (await work()).value),
}));

import { getProvider } from '../src/providers';
import { meterOperation } from '../src/lib/metering';
import { app } from '../src/index';

const executionContext = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;

describe('provider routing', () => {
  test('lists the implemented provider and its capabilities', async () => {
    const response = await app.request('/v1/providers', {}, {} as Env, executionContext);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      providers: [{ id: 'youtube', name: 'YouTube', capabilities: expect.arrayContaining(['search', 'transcript']) }],
    });
  });

  test('rejects an unsupported provider with a stable validation code', async () => {
    const response = await app.request('/v1/providers/vimeo/videos/video-1', {}, {} as Env, executionContext);

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'PROVIDER_NOT_SUPPORTED' } });
  });

  test('does not retain the unpublished unscoped source aliases', async () => {
    expect((await app.request('/v1/videos/video-1', {}, {} as Env, executionContext)).status).toBe(404);
    expect((await app.request('/v1/browse', {}, {} as Env, executionContext)).status).toBe(404);
  });
});


describe('explicit video refresh', () => {
  afterEach(() => vi.restoreAllMocks());
  test.each(['', '?refresh=false', '?refresh=true'])('forwards refresh selection %s', async (query) => {
    const provider = getProvider('youtube'), refresh = query === '?refresh=true';
    const metadata = vi.spyOn(provider, 'getVideo').mockResolvedValue({ cacheStatus: 'hit', value: {} } as never);
    const transcript = vi.spyOn(provider, 'getTranscript').mockResolvedValue({ cacheStatus: 'hit', value: {} } as never);
    const comments = vi.spyOn(provider, 'getComments').mockResolvedValue({ cacheStatus: 'hit', value: {} } as never);
    const all = vi.spyOn(provider, 'getAllComments').mockResolvedValue({ cacheStatus: 'hit', value: {} } as never);
    for (const suffix of ['', '/transcript', '/comments']) {
      expect((await app.request(`/v1/providers/youtube/videos/abcdefghijk${suffix}${query}`, {}, {} as Env, executionContext)).status).toBe(200);
    }
    await app.request(`/v1/providers/youtube/videos/abcdefghijk/comments${query || '?'}${query ? '&' : ''}all=true`, {}, {} as Env, executionContext);
    expect(metadata).toHaveBeenCalledWith(expect.anything(), 'abcdefghijk', refresh);
    expect(transcript).toHaveBeenCalledWith(expect.anything(), 'abcdefghijk', undefined, undefined, refresh);
    expect(comments).toHaveBeenCalledWith(expect.anything(), 'abcdefghijk', undefined, refresh);
    expect(all).toHaveBeenCalledWith(expect.anything(), 'abcdefghijk', refresh);
  });
  test.each(['', '/transcript', '/comments'])('rejects invalid refresh before billing %s', async (suffix) => {
    vi.mocked(meterOperation).mockClear();
    const response = await app.request(`/v1/providers/youtube/videos/abcdefghijk${suffix}?refresh=maybe`, {}, {} as Env, executionContext);
    expect(response.status).toBe(422);
    expect(meterOperation).not.toHaveBeenCalled();
  });
});
