import { Hono } from 'hono';
import type { App } from '../src/types';
import { jsonError } from '../src/lib/http';
import { dataRoutes } from '../src/routes/data/data.index';
import { searchPrivate } from '../src/lib/search';
import { meterOperation } from '../src/lib/metering';
import { citedAnswer } from '../src/lib/analysis';

vi.mock('../src/lib/search', async (original) => ({
  ...await original<typeof import('../src/lib/search')>(),
  searchPrivate: vi.fn(async () => [{ id: 'passage-1', score: 1, text: 'Project evidence', sourceKey: 'source-1' }]),
}));
vi.mock('../src/lib/metering', async (original) => ({
  ...await original<typeof import('../src/lib/metering')>(),
  meterOperation: vi.fn(async (_c, _options, work) => (await work()).value),
}));
vi.mock('../src/lib/analysis', () => ({ citedAnswer: vi.fn(async () => ({ answer: 'Cited answer', citations: [] })) }));

const app = new Hono<App>();
app.use('*', async (c, next) => {
  c.set('requestId', 'project-research-test');
  c.set('principal', { user: { id: 'owner', email: 'owner@example.com', name: 'Owner' }, method: 'session', permissions: {} });
  await next();
});
app.route('/v1', dataRoutes);
app.onError((error, c) => jsonError(c, error));

function environment(owned: boolean) {
  const first = vi.fn(async () => owned ? { id: 'project-1' } : null);
  const bind = vi.fn(() => ({ first }));
  const prepare = vi.fn(() => ({ bind }));
  return { env: { DB: { prepare } } as unknown as Env, bind, prepare };
}

const operations = [
  ['search', 'GET', undefined],
  ['answers', 'POST', { question: 'batteries' }],
  ['comparisons', 'POST', { question: 'batteries' }],
  ['reports', 'POST', { prompt: 'batteries' }],
] as const;

describe('project research routing', () => {
  beforeEach(() => vi.clearAllMocks());

  test.each(operations)('%s uses only the owned project in the path', async (operation, method, body) => {
    const { env, bind } = environment(true);
    const response = await app.request(`/v1/projects/project-1/${operation}?q=batteries`, {
      method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body),
    }, env);
    expect(response.status).toBe(200);
    expect(bind).toHaveBeenCalledWith('project-1', 'owner');
    expect(searchPrivate).toHaveBeenCalledWith(env, 'owner', 'batteries', 'project-1');
    if (operation !== 'search') expect(citedAnswer).toHaveBeenCalled();
  });

  test.each(operations)('%s rejects missing or other-user projects before metering', async (operation, method, body) => {
    const { env } = environment(false);
    const response = await app.request(`/v1/projects/other-project/${operation}?q=batteries`, {
      method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body),
    }, env);
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'PROJECT_NOT_FOUND' } });
    expect(meterOperation).not.toHaveBeenCalled();
    expect(searchPrivate).not.toHaveBeenCalled();
  });

  describe.each(operations.filter(([, method]) => method === 'POST'))('%s request body', (operation, method, body) => {
    test.each(['projectId', 'scope', 'entityId', 'provider'])('rejects body scope override %s', async (field) => {
      const { env } = environment(true);
      const response = await app.request(`/v1/projects/project-1/${operation}`, {
        method, headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, [field]: 'another-source' }),
      }, env);
      expect(response.status).toBe(422);
      expect(meterOperation).not.toHaveBeenCalled();
      expect(searchPrivate).not.toHaveBeenCalled();
    });
  });

  test('rejects a query project override', async () => {
    const { env } = environment(true);
    const response = await app.request('/v1/projects/project-1/search?q=batteries&projectId=other', {}, env);
    expect(response.status).toBe(422);
    expect(meterOperation).not.toHaveBeenCalled();
  });
});
