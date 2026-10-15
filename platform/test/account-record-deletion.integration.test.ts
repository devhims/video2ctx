import { env as workerEnv, SELF } from 'cloudflare:test';
import { describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import { deleteAccountRecords } from '../src/lib/account-deletion';
import { sha256, jsonError } from '../src/lib/http';
import { createAuth } from '../src/lib/auth';
import { handleQueue } from '../src/queues';
import { sessionRoutes } from '../src/routes/session/session.index';
import type { App } from '../src/types';

const env = workerEnv as Env;
async function user(id: string, email: string) {
  await env.DB.prepare('INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,1,0,0)').bind(id, id, email).run();
}

describe('account data outside the foreign-key cascades', () => {
  test('deletes owned delivery records and sign-in tokens, retains another account, and cascades credit records', async () => {
    const email = 'delete-metadata@example.test', other = 'retain-metadata@example.test';
    await user('delete-metadata', email); await user('retain-metadata', other);
    for (const [key, owner, recipient] of [['owned', 'delete-metadata', email], ['magic', null, email], ['other', 'retain-metadata', other]]) {
      await env.DB.prepare("INSERT INTO email_deliveries (idempotency_key,user_id,recipient_hash,template,status,updated_at) VALUES (?,?,?,'magic-link','sent',0)")
        .bind(key, owner, await sha256(recipient!)).run();
    }
    for (const [id, value] of [['delete-token', JSON.stringify({ email })], ['retain-token', JSON.stringify({ email: other })], ['non-json-token', 'opaque-token']]) {
      await env.DB.prepare('INSERT INTO verification (id,identifier,value,expiresAt,createdAt,updatedAt) VALUES (?,?,?,100000,0,0)').bind(id, id, value).run();
    }
    await deleteAccountRecords(env.DB, { id: 'delete-metadata', email });
    expect(await env.DB.prepare("SELECT id FROM user WHERE id='delete-metadata'").first()).toBeNull();
    expect(await env.DB.prepare("SELECT user_id FROM credit_accounts WHERE user_id='delete-metadata'").first()).toBeNull();
    expect(await env.DB.prepare("SELECT id FROM credit_ledger WHERE user_id='delete-metadata'").first()).toBeNull();
    expect((await env.DB.prepare('SELECT idempotency_key FROM email_deliveries').all()).results).toEqual([{ idempotency_key: 'other' }]);
    expect((await env.DB.prepare('SELECT id FROM verification ORDER BY id').all()).results).toEqual([{ id: 'non-json-token' }, { id: 'retain-token' }]);
    expect(await env.DB.prepare("SELECT id FROM user WHERE id='retain-metadata'").first()).not.toBeNull();
    await expect(deleteAccountRecords(env.DB, { id: 'delete-metadata', email })).resolves.toBeUndefined();
  });

  test('an email still queued for a deleted user recreates neither a delivery log nor a send', async () => {
    const email = 'deleted-email-queue@example.test';
    await user('deleted-email-queue', email);
    await deleteAccountRecords(env.DB, { id: 'deleted-email-queue', email });
    const send = vi.fn(), ack = vi.fn(), retry = vi.fn();
    await handleQueue({ queue: 'video2ctx-email', messages: [{ attempts: 1, ack, retry, body: {
      type: 'welcome', userId: 'deleted-email-queue', idempotencyKey: 'welcome:deleted-email-queue',
      to: email, subject: 'Welcome', html: '<p>Welcome</p>', text: 'Welcome',
    } }] } as unknown as MessageBatch<unknown>, { ...env, EMAIL: { send } } as unknown as Env);
    expect(send).not.toHaveBeenCalled(); expect(ack).toHaveBeenCalledOnce(); expect(retry).not.toHaveBeenCalled();
    expect(await env.DB.prepare("SELECT * FROM email_deliveries WHERE user_id='deleted-email-queue'").first()).toBeNull();
  });
});

test('successful account deletion clears Better Auth session and cached-session cookies', async () => {
  const sessionResponse = await SELF.fetch('http://auth.test/__test/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'delete-browser-session@example.test' }) });
  const session = await sessionResponse.json() as { user: { id: string; email: string }; cookie: string };
  const accountUser = { ...session.user, name: 'Auth Test User' };
  // Mock the external API rather than modules preloaded by the test Worker.
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    expect(new URL(request.url).hostname).toBe('sandbox-api.polar.sh');
    expect(['GET', 'DELETE']).toContain(request.method);
    return Response.json({ detail: 'Not found' }, { status: 404 });
  });
  const pending: Promise<unknown>[] = [];
  const auth = createAuth(env, { waitUntil: work => { pending.push(work); } });
  const app = new Hono<App>();
  app.use('*', async (c, next) => {
    c.set('auth', auth); c.set('user', accountUser);
    c.set('principal', { user: accountUser, method: 'session', permissions: {} }); await next();
  });
  app.route('/', sessionRoutes); app.onError((error, c) => jsonError(c, error));
  const response = await app.request('/account', { method: 'DELETE', headers: { cookie: session.cookie } }, {
    ...env,
    USER_ACCOUNT: env.USER_ACCOUNT,
    TASKS: { send: vi.fn() },
  });
  fetchSpy.mockRestore();
  expect(response.status).toBe(204);
  const cookies = response.headers.getSetCookie();
  expect(cookies.some(cookie => cookie.includes('better-auth.session_token=;') && cookie.includes('Max-Age=0'))).toBe(true);
  expect(cookies.some(cookie => cookie.includes('better-auth.session_data=;') && cookie.includes('Max-Age=0'))).toBe(true);
  expect(await env.DB.prepare('SELECT id FROM user WHERE id=?').bind(session.user.id).first()).toBeNull();
  expect(await auth.api.getSession({ headers: new Headers({ cookie: session.cookie }), query: { disableCookieCache: true } })).toBeNull();
  await Promise.all(pending);
});


test('a real queued magic link cannot recreate metadata after account deletion', async () => {
  const email = 'deleted-magic-link@example.test';
  await user('deleted-magic-link', email);
  const queued: import('../src/types').EmailMessage[] = [];
  const auth = createAuth({ ...env, EMAIL_TASKS: { send: async (message: import('../src/types').EmailMessage) => { queued.push(message); } } } as unknown as Env, { waitUntil: () => {} });
  await auth.api.signInMagicLink({ body: { email }, headers: new Headers({ origin: 'http://auth.test' }) });
  expect(queued).toHaveLength(1);
  expect(await env.DB.prepare("SELECT id FROM verification WHERE json_extract(value,'$.email')=?").bind(email).first()).not.toBeNull();
  await deleteAccountRecords(env.DB, { id: 'deleted-magic-link', email });
  const send = vi.fn(), ack = vi.fn();
  await handleQueue({ queue: 'video2ctx-email', messages: [{ attempts: 1, ack, retry: vi.fn(), body: queued[0] }] } as unknown as MessageBatch<unknown>, { ...env, EMAIL: { send } } as unknown as Env);
  expect(send).not.toHaveBeenCalled();
  expect(ack).toHaveBeenCalledOnce();
  expect(await env.DB.prepare('SELECT * FROM email_deliveries WHERE recipient_hash=?').bind(await sha256(email)).first()).toBeNull();
});


test('a valid signup magic link sends without a user row and old links stay suppressed after re-registration', async () => {
  const email = 'fresh-magic-signup@example.test';
  const queued: import('../src/types').EmailMessage[] = [];
  const auth = createAuth({ ...env, EMAIL_TASKS: { send: async (message: import('../src/types').EmailMessage) => { queued.push(message); } } } as unknown as Env, { waitUntil: () => {} });
  const enqueue = () => auth.api.signInMagicLink({ body: { email }, headers: new Headers({ origin: 'http://auth.test' }) });
  await enqueue();
  const send = vi.fn(async () => ({ messageId: 'sent' }));
  const deliver = (body: import('../src/types').EmailMessage) => handleQueue({ queue: 'video2ctx-email', messages: [{ attempts: 1, ack: vi.fn(), retry: vi.fn(), body }] } as unknown as MessageBatch<unknown>, { ...env, EMAIL: { send } } as unknown as Env);
  expect(queued[0]!.verificationId).toBeTruthy();
  await deliver(queued[0]!); expect(send.mock.calls.length).toBe(1);
  await user('fresh-magic-old-user', email);
  await enqueue(); const obsolete = queued[1]!;
  await deleteAccountRecords(env.DB, { id: 'fresh-magic-old-user', email });
  await user('fresh-magic-new-user', email);
  await enqueue();
  await deliver(obsolete); expect(send.mock.calls.length).toBe(1);
  await deliver(queued[2]!); expect(send.mock.calls.length).toBe(2);
  await deliver({ ...queued[2]!, verificationId: undefined, idempotencyKey: 'legacy-magic' });
  expect(send.mock.calls.length).toBe(2);
});
