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
