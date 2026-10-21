import { Hono } from 'hono';
import type { App } from '../src/types';
import { ApiError, jsonError } from '../src/lib/http';
import { framePreviewPrefix } from '../src/agents/runtime/frame-previews';

vi.mock('../src/lib/admin-identity', () => ({ assertAccountDeletable: vi.fn() }));
const closeBillingAccount = vi.hoisted(() => vi.fn());
const requireNoRenewingSubscription = vi.hoisted(() => vi.fn());
vi.mock('../src/lib/billing-coordination', () => ({ billingAccount: async () => ({ claimBillingDeletion: async () => 'acquired', commitBillingDeletion: vi.fn(), endBillingDeletion: vi.fn() }) }));
vi.mock('../src/lib/billing', () => ({ closeBillingAccount, requireNoRenewingSubscription }));
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
    DB: { prepare: () => ({ bind: () => ({ run: vi.fn() }) }), batch: vi.fn() },
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


test('billing failure leaves the account and every local store usable for retry', async () => {
  closeBillingAccount.mockRejectedValueOnce(new ApiError(503, 'BILLING_UNAVAILABLE', 'Billing cleanup is unavailable.'));
  const beginDeletion = vi.fn().mockResolvedValue([]);
  const localDelete = vi.fn();
  const env = {
    USER_ACCOUNT: { getByName: () => ({ beginDeletion, finishDeletion: localDelete }) },
    RESEARCH: { list: localDelete, delete: localDelete },
    TASKS: { send: localDelete },
    DB: { prepare: localDelete },
  } as unknown as Env;
  const app = new Hono<App>();
  app.use('*', async (c, next) => {
    const user = { id: 'owner', email: 'owner@example.test', name: 'Owner' };
    c.set('user', user); c.set('principal', { user, method: 'session', permissions: {} }); await next();
  });
  app.route('/', sessionRoutes);
  app.onError((error, c) => jsonError(c, error));
  expect((await app.request('/account', { method: 'DELETE' }, env)).status).toBe(503);
  expect(beginDeletion).not.toHaveBeenCalled();
  expect(localDelete).not.toHaveBeenCalled();
});


test('a renewing subscription blocks deletion before billing closure or local cleanup', async () => {
  requireNoRenewingSubscription.mockRejectedValueOnce(new ApiError(409, 'SUBSCRIPTION_ACTIVE', 'Cancel your Builder plan before deleting your account.'));
  const beforeCalls = closeBillingAccount.mock.calls.length;
  const local = vi.fn();
  const app = new Hono<App>();
  app.use('*', async (c, next) => {
    const user = { id: 'owner', email: 'owner@example.test', name: 'Owner' };
    c.set('user', user); c.set('principal', { user, method: 'session', permissions: {} }); await next();
  });
  app.route('/', sessionRoutes); app.onError((error, c) => jsonError(c, error));
  const response = await app.request('/account', { method: 'DELETE' }, { USER_ACCOUNT: { getByName: local }, DB: { prepare: local } });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: { code: 'SUBSCRIPTION_ACTIVE' } });
  expect(closeBillingAccount.mock.calls.length).toBe(beforeCalls);
  expect(local).not.toHaveBeenCalled();
});

test('a local cleanup failure keeps the account record and asks the user to retry', async () => {
  const removeAccount = vi.fn();
  const app = new Hono<App>();
  app.use('*', async (c, next) => {
    const user = { id: 'owner', email: 'owner@example.test', name: 'Owner' };
    c.set('user', user); c.set('principal', { user, method: 'session', permissions: {} }); await next();
  });
  app.route('/', sessionRoutes); app.onError((error, c) => jsonError(c, error));
  const response = await app.request('/account', { method: 'DELETE' }, {
    USER_ACCOUNT: { getByName: () => ({ beginDeletion: async () => { throw new Error('storage unavailable'); } }) },
    DB: { batch: removeAccount },
  });
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ error: { code: 'ACCOUNT_DELETION_INCOMPLETE' } });
  expect(removeAccount).not.toHaveBeenCalled();
});

test('successful deletion forwards expired browser cookies after removing the user', async () => {
  const removed = vi.fn(), signOut = vi.fn(async () => {
    expect(removed).toHaveBeenCalledOnce();
    return { headers: new Headers([['set-cookie', 'better-auth.session_token=; Max-Age=0; Path=/'], ['set-cookie', 'better-auth.session_data=; Max-Age=0; Path=/']]) };
  });
  const app = new Hono<App>();
  app.use('*', async (c, next) => {
    const user = { id: 'owner', email: 'owner@example.test', name: 'Owner' };
    c.set('user', user); c.set('principal', { user, method: 'session', permissions: {} });
    c.set('auth', { api: { signOut } } as unknown as NonNullable<App['Variables']['auth']>);
    await next();
  });
  app.route('/', sessionRoutes); app.onError((error, c) => jsonError(c, error));
  const response = await app.request('/account', { method: 'DELETE', headers: { cookie: 'better-auth.session_token=old' } }, {
    USER_ACCOUNT: { getByName: () => ({ beginDeletion: async () => [], finishDeletion: vi.fn() }) },
    RESEARCH: { list: async () => ({ objects: [], truncated: false }) }, TASKS: { send: vi.fn() },
    DB: { prepare: () => ({ bind: vi.fn() }), batch: removed },
  });
  expect(response.status).toBe(204);
  expect(signOut).toHaveBeenCalledOnce();
  expect(response.headers.getSetCookie()).toEqual(['better-auth.session_token=; Max-Age=0; Path=/', 'better-auth.session_data=; Max-Age=0; Path=/']);
});
