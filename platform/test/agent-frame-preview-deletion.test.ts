import { Hono } from 'hono';
import type { App } from '../src/types';
import { jsonError } from '../src/lib/http';
import { framePreviewPrefix } from '../src/agents/runtime/frame-previews';

vi.mock('../src/lib/billing', () => ({ closeBillingAccount: vi.fn() }));
vi.mock('../src/lib/oauth', () => ({ disconnectYoutube: vi.fn() }));
import { sessionRoutes } from '../src/routes/session/session.index';

test('account deletion drains agent work and removes only the owner frame collection', async () => {
  const ownerPrefix = await framePreviewPrefix('owner');
  const otherPrefix = await framePreviewPrefix('other');
  const owned = `${ownerPrefix}${'a'.repeat(64)}.jpg`;
  const other = `${otherPrefix}${'b'.repeat(64)}.jpg`;
  const objects = new Set([owned, other, 'private/owner/note.md']);
  let drained = false;
  const env = {
    USER_ACCOUNT: { getByName: () => ({ beginDeletion: async () => ['conversation'], finishDeletion: vi.fn() }) },
    AGENT_RUNTIME: { getByName: () => ({ deleteAccountData: async () => { drained = true; } }) },
    RESEARCH: {
      list: async ({ prefix }: { prefix: string }) => {
        expect(drained).toBe(true);
        return { truncated: false, objects: [...objects].filter(key => key.startsWith(prefix)).map(key => ({ key })) };
      },
      delete: async (keys: string[]) => { keys.forEach(key => objects.delete(key)); },
    },
    TASKS: { send: vi.fn() },
    DB: { prepare: () => ({ bind: () => ({ run: vi.fn() }) }) },
  } as unknown as Env;
  const app = new Hono<App>();
  app.use('*', async (c, next) => {
    const user = { id: 'owner', email: 'owner@example.test', name: 'Owner' };
    c.set('user', user); c.set('principal', { user, method: 'session', permissions: {} }); await next();
  });
  app.route('/', sessionRoutes);
  app.onError((error, c) => jsonError(c, error));
  expect((await app.request('/account', { method: 'DELETE' }, env)).status).toBe(204);
  expect([...objects]).toEqual([other]);
});
