import { app } from '../src/app';
import { searchPrivate } from '../src/lib/search';
import { meterOperation } from '../src/lib/metering';

const authState = vi.hoisted(() => ({ verifyApiKey: vi.fn(), getSession: vi.fn() }));
vi.mock('../src/lib/auth', () => ({
  createAuth: vi.fn(() => ({ api: authState })),
}));
vi.mock('../src/lib/search', async (original) => ({
  ...await original<typeof import('../src/lib/search')>(),
  searchPrivate: vi.fn(async () => []),
}));
vi.mock('../src/lib/metering', async (original) => ({
  ...await original<typeof import('../src/lib/metering')>(),
  meterOperation: vi.fn(async (_c, _options, work) => (await work()).value),
}));

const user = { id: 'owner', email: 'owner@example.com', name: 'Owner' };
const executionContext = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;

function environment(owned = true) {
  const projectLookup = vi.fn(async () => owned ? { id: 'project-1' } : null);
  const env = {
    ENVIRONMENT: 'production',
    DB: {
      prepare: vi.fn((sql: string) => ({
        bind: vi.fn(() => ({ first: sql.includes('FROM projects') ? projectLookup : vi.fn(async () => user) })),
      })),
    },
  } as unknown as Env;
  return { env, projectLookup };
}

function useKey(permissions: Record<string, readonly string[]>) {
  authState.verifyApiKey.mockResolvedValue({
    valid: true, error: null, key: { id: 'key-1', referenceId: user.id, permissions },
  });
}

describe('project search through the full application', () => {
  beforeEach(() => vi.clearAllMocks());

  test.each([
    ['data only', { data: ['read'] }],
    ['account only', { account: ['access'] }],
    ['neither', {}],
  ] as const)('rejects a key with %s permissions before project access or billing', async (_label, permissions) => {
    useKey(permissions);
    const { env, projectLookup } = environment();
    const response = await app.request('/v1/projects/project-1/search?q=batteries', {
      headers: { authorization: 'Bearer aty_restricted' },
    }, env, executionContext);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'API_KEY_PERMISSION_REQUIRED' } });
    expect(projectLookup).not.toHaveBeenCalled();
    expect(meterOperation).not.toHaveBeenCalled();
    expect(searchPrivate).not.toHaveBeenCalled();
  });

  test.each(['api-key', 'cli-session', 'session'])('allows %s access to the owned project', async (method) => {
    useKey({ data: ['read'], account: ['access'] });
    authState.getSession.mockResolvedValue({ user, session: { id: 'session-1' } });
    const headers: Record<string, string> = method === 'session'
      ? { cookie: 'better-auth.session_token=session-token' }
      : { authorization: `Bearer ${method === 'api-key' ? 'aty_full' : 'cli-session-token'}` };
    const { env, projectLookup } = environment();
    const response = await app.request('/v1/projects/project-1/search?q=batteries', { headers }, env, executionContext);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ query: 'batteries', results: [] });
    expect(projectLookup).toHaveBeenCalledOnce();
    expect(searchPrivate).toHaveBeenCalledWith(env, user.id, 'batteries', 'project-1');
  });

  test('rejects another owner’s project even with both permissions', async () => {
    useKey({ data: ['read'], account: ['access'] });
    const { env } = environment(false);
    const response = await app.request('/v1/projects/project-1/search?q=batteries', {
      headers: { authorization: 'Bearer aty_full' },
    }, env, executionContext);
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'PROJECT_NOT_FOUND' } });
    expect(meterOperation).not.toHaveBeenCalled();
    expect(searchPrivate).not.toHaveBeenCalled();
  });
});
