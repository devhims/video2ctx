import { env as workerEnv, SELF, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import { adminRoutes } from '../src/routes/admin/admin.index';
import { createAuth } from '../src/lib/auth';
import { deleteAccount } from '../src/lib/account-deletion';
import { billingAccount } from '../src/lib/billing-coordination';
import { BillingGate } from '../src/durable-objects/billing-gate';
import { jsonError } from '../src/lib/http';
import type { App } from '../src/types';

const env = workerEnv as Env;
afterEach(() => vi.restoreAllMocks());
async function session(email = `admin-delete-${crypto.randomUUID()}@example.test`) {
  const response = await SELF.fetch('http://auth.test/__test/session', { method: 'POST', body: JSON.stringify({ email }) });
  return response.json() as Promise<{ user: { id: string; email: string }; cookie: string }>;
}
async function setup() {
  const admin = await session();
  await env.DB.prepare("UPDATE user SET role='admin' WHERE id=?").bind(admin.user.id).run();
  const target = await session();
  const configured = { ...env, TASKS: { send: vi.fn() } } as unknown as Env;
  const auth = createAuth(configured, { waitUntil: () => {} });
  const app = new Hono<App>();
  app.use('*', async (c, next) => { c.set('auth', auth); await next(); });
  app.route('/', adminRoutes); app.onError((error, c) => jsonError(c, error));
  const request = (path: string, init: RequestInit = {}) => app.request(path, { ...init, headers: { cookie: admin.cookie, origin: env.APP_ORIGIN, 'content-type': 'application/json', ...init.headers } }, configured);
  const remove = (id = target.user.id, email = target.user.email, headers = {}) => request(`/admin/users/${id}`, { method: 'DELETE', body: JSON.stringify({ email }), headers });
  return { admin, target, configured, auth, request, remove };
}
function noPolarCustomer() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    expect(new URL(request.url).hostname).toBe('sandbox-api.polar.sh');
    return Response.json({ detail: 'Not found' }, { status: 404 });
  });
}

test('admin search finds exact IDs and case-insensitive email fragments, with literal search and pagination', async () => {
  const { target, request } = await setup();
  for (const q of [target.user.id, target.user.email.toUpperCase()]) {
    const response = await request(`/admin/users?q=${encodeURIComponent(q)}`);
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ users: [{ ...target.user, plan: 'starter' }], nextOffset: null });
  }
  expect(await (await request('/admin/users?q=%25')).json()).toMatchObject({ users: [] });
  expect((await request('/admin/users?q=')).status).toBe(422);
  expect((await request('/admin/users?q=a&offset=-1')).status).toBe(422);
  for (let i = 0; i < 26; i++) await env.DB.prepare('INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,1,0,0)')
    .bind(`paged-${i}`, 'Page', `paged-${String(i).padStart(2, '0')}@pagination.test`).run();
  const page = await (await request('/admin/users?q=@pagination.test')).json() as { users: { id: string }[]; nextOffset: number };
  expect(page.users).toHaveLength(25); expect(page.nextOffset).toBe(25);
  const next = await (await request(`/admin/users?q=@pagination.test&offset=${page.nextOffset}`)).json() as { users: { id: string }[]; nextOffset: number | null };
  expect(next.users).toHaveLength(1); expect(next.nextOffset).toBeNull(); expect(page.users.map(user => user.id)).not.toContain(next.users[0]!.id);
});

test('admin deletion requires a live admin browser session, trusted origin and matching account identity', async () => {
  const { admin, target, request, remove } = await setup(); const polar = noPolarCustomer();
  expect((await remove(target.user.id, 'wrong@example.test')).status).toBe(409);
  expect((await remove(admin.user.id, admin.user.email)).status).toBe(409);
  expect((await remove(target.user.id, target.user.email, { origin: 'https://untrusted.test' })).status).toBe(403);
  expect((await remove(target.user.id, target.user.email, { cookie: target.cookie })).status).toBe(403);
  const credentials: Array<Record<string, string>> = [{ authorization: 'Bearer fake' }, { 'x-api-key': 'fake' }, { 'x-demo-user': 'fake' }];
  for (const headers of credentials) {
    expect((await remove(target.user.id, target.user.email, headers)).status).toBe(403);
    expect((await request('/admin/users?q=example', { headers })).status).toBe(403);
  }
  expect((await request('/admin/users?q=example', { headers: { cookie: '' } })).status).toBe(401);
  await env.DB.prepare("UPDATE user SET role='user' WHERE id=?").bind(admin.user.id).run();
  expect((await remove()).status).toBe(403); expect(polar).not.toHaveBeenCalled();
  expect(await env.DB.prepare('SELECT id FROM user WHERE id=?').bind(target.user.id).first()).not.toBeNull();
});

test('admin deletion anonymizes the target customer, clears its sources and private files, and keeps the admin signed in', async () => {
  const { admin, target, configured, auth, remove } = await setup(); const polar = noPolarCustomer();
  const account = await billingAccount(env, target.user.id);
  await runInDurableObject(account, async (_instance, state) => {
    state.storage.sql.exec("INSERT INTO recent_sources (id,source_key,input,title,kind,updated_at,snapshot) VALUES ('source','source','input','Private source','inspection',0,'{}')");
  });
  const owned = `private/${target.user.id}/note.md`, other = `private/${admin.user.id}/note.md`;
  await env.RESEARCH.put(owned, 'Private note'); await env.RESEARCH.put(other, 'Other note');
  const response = await remove(); expect(response.status).toBe(204); expect(response.headers.getSetCookie()).toEqual([]);
  expect(polar.mock.calls.map(([input, init]) => new Request(input, init)).some(request => request.method === 'DELETE' && request.url.endsWith(`/customers/external/${target.user.id}?anonymize=true`))).toBe(true);
  expect(await env.DB.prepare('SELECT id FROM user WHERE id=?').bind(target.user.id).first()).toBeNull();
  expect(await env.RESEARCH.get(owned)).toBeNull(); expect(await env.RESEARCH.get(other)).not.toBeNull();
  await runInDurableObject(account, async (_instance, state) => { expect(state.storage.sql.exec('SELECT * FROM recent_sources').toArray()).toEqual([]); });
  expect(configured.TASKS.send).toHaveBeenCalledOnce();
  expect(await auth.api.getSession({ headers: new Headers({ cookie: admin.cookie }), query: { disableCookieCache: true } })).not.toBeNull();
  expect(await auth.api.getSession({ headers: new Headers({ cookie: target.cookie }), query: { disableCookieCache: true } })).toBeNull();
  expect((await remove()).status).toBe(204);
});

test('checkout is fenced while customer deletion is in flight and after cleanup, without any replacement-customer request', async () => {
  const { target, configured, auth } = await setup();
  let entered!: () => void, release!: () => void;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const requests: Request[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init); requests.push(request);
    if (request.method === 'DELETE') { entered(); await held; return new Response(null, { status: 204 }); }
    return Response.json({ detail: 'Not found' }, { status: 404 });
  });
  const deleting = deleteAccount(configured, target.user);
  await enteredPromise;
  try {
    await expect(auth.api.checkout({ body: { slug: 'builder' }, headers: new Headers({ cookie: target.cookie }) })).rejects.toMatchObject({ status: 'CONFLICT' });
    expect(requests).toHaveLength(2);
  } finally { release(); await deleting; }
  const account = await billingAccount(env, target.user.id);
  expect(await account.beginBillingCheckout(crypto.randomUUID())).toBe(false);
  expect(requests.filter(request => request.method === 'POST')).toHaveLength(0);
});

test('deletion refuses an already in-flight authenticated checkout before touching Polar and succeeds on retry', async () => {
  const { target, configured, auth } = await setup();
  let entered!: () => void, release!: () => void;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const requests: Request[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init); requests.push(request);
    if (request.url.includes('/customers/external/') && request.method === 'GET') { entered(); await held; }
    return Response.json({ detail: 'Not found' }, { status: 404 });
  });
  const checkingOut = auth.api.checkout({ body: { slug: 'builder' }, headers: new Headers({ cookie: target.cookie }) }).catch(error => error);
  await enteredPromise;
  try {
    await expect(deleteAccount(configured, target.user)).rejects.toMatchObject({ code: 'BILLING_OPERATION_PENDING' });
    expect(requests).toHaveLength(1);
    expect(await env.DB.prepare('SELECT id FROM user WHERE id=?').bind(target.user.id).first()).not.toBeNull();
  } finally { release(); await checkingOut; }
  await expect(deleteAccount(configured, target.user)).resolves.toBeUndefined();
});

test('billing claims persist across coordinator instances and a failed preflight releases only its temporary fence', async () => {
  const { target } = await setup();
  const account = await billingAccount(env, target.user.id);
  expect(await account.beginBillingCheckout('checkout')).toBe(true);
  const another = await billingAccount(env, target.user.id);
  expect(await another.beginBillingDeletion('delete')).toBe(false);
  await account.endBillingCheckout('checkout');
  expect(await another.beginBillingDeletion('delete')).toBe(true);
  expect(await account.beginBillingCheckout('replacement')).toBe(false);
  expect(await account.beginBillingDeletion('concurrent-delete')).toBe(false);
  await another.endBillingDeletion('wrong-claim');
  expect(await account.beginBillingCheckout('replacement')).toBe(false);
  await another.endBillingDeletion('delete');
  expect(await account.beginBillingCheckout('retry')).toBe(true);
  await account.endBillingCheckout('retry');
  expect(await account.beginBillingDeletion('committed-delete')).toBe(true);
  await account.commitBillingDeletion('committed-delete'); await account.endBillingDeletion('committed-delete');
  expect(await another.beginBillingCheckout('late')).toBe(false);
  expect(await another.beginBillingDeletion('deletion-retry')).toBe(true);
  await another.endBillingDeletion('deletion-retry');
  expect(await account.beginBillingCheckout('still-fenced')).toBe(false);
});

test.each(['admin', 'user, admin', 'operator-email'])('admin accounts cannot be deleted through either endpoint: %s', async identity => {
  const { target, configured, auth, request, remove } = await setup();
  const before = await (await request(`/admin/users?q=${target.user.id}`)).json() as { users: { isAdmin: boolean }[] };
  expect(before.users[0]?.isAdmin).toBe(false);
  if (identity === 'operator-email') {
    await env.DB.prepare('UPDATE user SET email=? WHERE id=?').bind('BOOTSTRAP-ADMIN@example.test', target.user.id).run();
    target.user.email = 'BOOTSTRAP-ADMIN@example.test';
  } else await env.DB.prepare('UPDATE user SET role=? WHERE id=?').bind(identity, target.user.id).run();
  const polar = noPolarCustomer();
  const response = await remove();
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: { code: 'ADMIN_ACCOUNT_PROTECTED' } });
  const app = new Hono<App>();
  app.use('*', async (c, next) => {
    const user = { ...target.user, name: 'Protected admin' };
    c.set('auth', auth); c.set('user', user); c.set('principal', { user, method: 'session', permissions: {} }); await next();
  });
  const { sessionRoutes } = await import('../src/routes/session/session.index');
  app.route('/', sessionRoutes); app.onError((error, c) => jsonError(c, error));
  const self = await app.request('/account', { method: 'DELETE', headers: { cookie: target.cookie } }, configured);
  expect(self.status).toBe(409);
  expect(await self.json()).toMatchObject({ error: { code: 'ADMIN_ACCOUNT_PROTECTED' } });
  expect(polar.mock.calls.length).toBe(0);
  expect(configured.TASKS.send).not.toHaveBeenCalled();
  expect(await env.DB.prepare('SELECT id FROM user WHERE id=?').bind(target.user.id).first()).not.toBeNull();
  // A rejected attempt must not even fence normal checkout or clear sources.
  const account = await billingAccount(env, target.user.id);
  expect(await account.beginBillingCheckout('protected-check')).toBe(true);
  await account.endBillingCheckout('protected-check');
  const found = await (await request(`/admin/users?q=${encodeURIComponent(target.user.id)}`)).json() as { users: { isAdmin: boolean }[] };
  expect(found.users[0]?.isAdmin).toBe(true);
});

test.each(['ECONNRESET', 504, 408, 'invalid-response'] as const)('ambiguous customer creation retains its billing fence until reconciliation: %s', async failure => {
  const { target, auth, remove, configured } = await setup();
  let acceptedCreates = 0, customerCommitted = false;
  const requests: Request[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init); requests.push(request);
    if (request.method === 'POST' && request.url.endsWith('/customers/')) {
      acceptedCreates++;
      if (failure === 'ECONNRESET') throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
      if (failure === 'invalid-response') return Response.json({}, { status: 201 });
      return Response.json({ detail: 'Gateway timeout' }, { status: failure });
    }
    if (request.method === 'DELETE') { customerCommitted = false; return new Response(null, { status: 204 }); }
    return Response.json({ detail: 'Not found' }, { status: 404 });
  });
  await expect(auth.api.checkout({ body: { slug: 'builder' }, headers: new Headers({ cookie: target.cookie }) })).rejects.toMatchObject({ status: 'CONFLICT' });
  expect(acceptedCreates).toBe(1);
  const response = await remove();
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: { code: 'BILLING_OPERATION_PENDING' } });
  expect(await env.DB.prepare('SELECT id FROM user WHERE id=?').bind(target.user.id).first()).not.toBeNull();
  expect(requests.some(request => request.method === 'DELETE')).toBe(false);
  await auth.api.checkout({ body: { slug: 'builder' }, headers: new Headers({ cookie: target.cookie }) }).catch(() => {});
  expect(acceptedCreates).toBe(1);
  const account = await billingAccount(env, target.user.id);
  let claim = '';
  await runInDurableObject(account, async (_instance, state) => {
    const claims = state.storage.sql.exec<{ id: string }>('SELECT id FROM billing_checkouts').toArray();
    expect(claims).toHaveLength(1); claim = claims[0]!.id;
    expect(state.storage.sql.exec('SELECT id,operation,state FROM billing_checkout_writes').toArray())
      .toEqual([{ id: claim, operation: 'customer-create', state: 'uncertain' }]);
    const reopened = new BillingGate(state.storage.sql);
    expect(reopened.beginCheckout('after-reopen')).toBe(false);
    expect(reopened.beginDeletion('after-reopen')).toBe(false);
  });
  const sent = await requests.find(request => request.method === 'POST')!.clone().json() as { metadata: { billing_checkout_claim: string } };
  expect(sent.metadata.billing_checkout_claim).toBe(claim);
  await account.endBillingCheckout(claim);
  expect((await remove()).status).toBe(409);
  // Simulate the previously accepted POST completing only after the failed deletion.
  customerCommitted = true;
  expect(configured.TASKS.send).not.toHaveBeenCalled();
  // Only after this specific write is confirmed terminal may an operator resolve
  // its marker and release the claim. An earlier 404 is not that confirmation.
  expect((await remove()).status).toBe(409);
  await account.finishBillingCheckoutWrite(claim); await account.endBillingCheckout(claim);
  expect((await remove()).status).toBe(204);
  expect(customerCommitted).toBe(false);
  expect(await env.DB.prepare('SELECT id FROM user WHERE id=?').bind(target.user.id).first()).toBeNull();
});


test.each([400, 401, 403, 409, 422, 429])('a definitive customer-create rejection releases the fence: %s', async status => {
  const { target, auth, remove } = await setup();
  let posts = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (request.method === 'POST') { posts++; return Response.json(status === 422 ? { detail: [] } : { detail: 'Rejected' }, { status }); }
    return Response.json({ detail: 'Not found' }, { status: 404 });
  });
  await auth.api.checkout({ body: { slug: 'builder' }, headers: new Headers({ cookie: target.cookie }) }).catch(() => {});
  expect(posts).toBe(1);
  const account = await billingAccount(env, target.user.id);
  await runInDurableObject(account, async (_instance, state) => {
    expect(state.storage.sql.exec('SELECT * FROM billing_checkout_writes').toArray()).toEqual([]);
    expect(state.storage.sql.exec('SELECT * FROM billing_checkouts').toArray()).toEqual([]);
  });
  expect((await remove()).status).toBe(204);
});

test('an ambiguous checkout-create response also retains its write marker', async () => {
  const { target, auth, remove } = await setup();
  const customer = {
    id: 'known-customer', created_at: '2026-10-14T00:00:00Z', modified_at: null, metadata: {},
    external_id: target.user.id, email: target.user.email, email_verified: true, type: 'individual', name: 'Auth Test User',
    billing_address: null, tax_id: null, organization_id: 'sandbox-organization', deleted_at: null, avatar_url: 'https://example.test/avatar',
  };
  let posts = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (request.method === 'GET') return Response.json(customer);
    expect(request.url).toBe('https://sandbox-api.polar.sh/v1/checkouts/');
    posts++; return Response.json({ detail: 'Gateway timeout' }, { status: 504 });
  });
  await expect(auth.api.checkout({ body: { slug: 'builder' }, headers: new Headers({ cookie: target.cookie }) })).rejects.toMatchObject({ status: 'CONFLICT' });
  expect((await remove()).status).toBe(409);
  expect(posts).toBe(1);
  const account = await billingAccount(env, target.user.id);
  await runInDurableObject(account, async (_instance, state) => {
    expect(state.storage.sql.exec('SELECT operation,state FROM billing_checkout_writes').toArray())
      .toEqual([{ operation: 'checkout-create', state: 'uncertain' }]);
  });
});
