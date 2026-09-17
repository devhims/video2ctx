import { env, exports } from 'cloudflare:workers';
import { describe, expect, test } from 'vitest';

const base = 'http://auth.test';
const worker = exports.default;
const request = (path: string, init?: RequestInit) => worker.fetch(new Request(new URL(path, base), init));
async function session(email?: string): Promise<{ user: { id: string; email: string }; cookie: string }> {
  const response = await request('/__test/session', { method: 'POST', body: JSON.stringify({ email }) });
  expect(response.status).toBe(200);
  return response.json();
}
const headers = (cookie: string) => ({ cookie, origin: base, 'content-type': 'application/json' });
const access = (cookie: string) => request('/v1/admin/access', { headers: { cookie } });
const grant = (cookie: string, email: string) => request('/v1/admin/agent-access', { method: 'POST', headers: headers(cookie), body: JSON.stringify({ email }) });

describe('admin plugin and Agent access management', () => {
  test('an existing operator can use the plugin and manage D1 grants independently of Agent access', async () => {
    const admin = await session('bootstrap-admin@example.test');
    const tester = await session();
    expect((await access(admin.cookie)).status).toBe(200);
    const users = await request('/api/auth/admin/list-users?limit=10', { headers: { cookie: admin.cookie } });
    expect(users.status).toBe(200);
    expect(await users.json()).toMatchObject({ users: expect.any(Array), total: expect.any(Number) });
    expect((await request('/v1/admin/jobs', { headers: { cookie: admin.cookie } })).status).toBe(200);
    expect((await request('/v1/agent/access', { headers: { cookie: admin.cookie } })).status).toBe(403);

    expect((await grant(admin.cookie, `  ${tester.user.email.toUpperCase()}  `)).status).toBe(200);
    expect((await grant(admin.cookie, tester.user.email)).status).toBe(200);
    const list = await request(`/v1/admin/agent-access?q=${encodeURIComponent(tester.user.email)}&limit=1`, { headers: { cookie: admin.cookie } });
    expect(list.headers.get('Cache-Control')).toBe('no-store');
    expect(await list.json()).toMatchObject({ total: 1, limit: 1, entries: [{ email: tester.user.email, createdAt: expect.any(Number) }] });
    expect((await request('/v1/agent/access', { headers: { cookie: tester.cookie } })).status).toBe(200);
    expect((await access(tester.cookie)).status).toBe(403);
    expect((await grant(tester.cookie, 'unauthorized@example.test')).status).toBe(403);
    expect((await request('/api/auth/admin/list-users', { headers: { cookie: tester.cookie } })).status).toBe(403);

    const remove = await request('/v1/admin/agent-access', { method: 'DELETE', headers: headers(admin.cookie), body: JSON.stringify({ email: tester.user.email }) });
    expect(remove.status).toBe(200);
    expect((await request('/v1/agent/access', { headers: { cookie: tester.cookie } })).status).toBe(403);
  });

  test('role changes, email verification, bans and session revocations are checked without cached admin claims', async () => {
    const admin = await session();
    expect((await access(admin.cookie)).status).toBe(403);
    await env.DB.prepare("UPDATE user SET role='admin' WHERE id=?").bind(admin.user.id).run();
    expect((await access(admin.cookie)).status).toBe(200);
    await env.DB.prepare('UPDATE user SET emailVerified=0 WHERE id=?').bind(admin.user.id).run();
    expect((await access(admin.cookie)).status).toBe(403);
    await env.DB.prepare('UPDATE user SET emailVerified=1, banned=1 WHERE id=?').bind(admin.user.id).run();
    expect((await access(admin.cookie)).status).toBe(403);
    await env.DB.prepare("UPDATE user SET banned=0, role='user' WHERE id=?").bind(admin.user.id).run();
    expect((await request('/api/auth/admin/list-users', { headers: { cookie: admin.cookie } })).status).toBe(403);
    await env.DB.prepare("UPDATE user SET role='admin' WHERE id=?").bind(admin.user.id).run();
    expect((await access(admin.cookie)).status).toBe(200);
    await env.DB.prepare('DELETE FROM session WHERE userId=?').bind(admin.user.id).run();
    expect((await access(admin.cookie)).status).toBe(401);
  });

  test('requires a browser session and same-origin JSON mutations; rejects invalid email and pagination', async () => {
    const admin = await session();
    await env.DB.prepare("UPDATE user SET role='admin' WHERE id=?").bind(admin.user.id).run();
    expect((await request('/v1/admin/access')).status).toBe(401);
    const credentials: Record<string, string>[] = [{ authorization: 'Bearer cli-token' }, { 'x-api-key': 'aty_key' }, { 'x-demo-user': 'admin' }];
    for (const credential of credentials) {
      for (const path of ['/v1/admin/access', '/v1/admin/agent-access', '/api/auth/admin/list-users']) {
        expect((await request(path, { headers: { cookie: admin.cookie, ...credential } })).status).toBe(403);
      }
    }
    for (const origin of ['', 'https://attacker.example']) {
      expect((await request('/v1/admin/agent-access', { method: 'POST', headers: { ...headers(admin.cookie), origin }, body: JSON.stringify({ email: 'target@example.test' }) })).status).toBe(403);
    }
    expect((await grant(admin.cookie, 'invalid')).status).toBe(422);
    expect((await request('/v1/admin/agent-access?limit=1000', { headers: headers(admin.cookie) })).status).toBe(422);
    expect((await grant(admin.cookie, 'not-signed-up@example.test')).status).toBe(200);
    expect((await request('/v1/admin/agent-access?q=not-signed-up&offset=1&limit=1', { headers: headers(admin.cookie) })).status).toBe(200);
  });

  test('impersonated sessions cannot manage access and the plugin delete shortcut stays disabled', async () => {
    const admin = await session();
    await env.DB.prepare("UPDATE user SET role='admin' WHERE id=?").bind(admin.user.id).run();
    const removal = await request('/api/auth/admin/remove-user', { method: 'POST', headers: headers(admin.cookie), body: JSON.stringify({ userId: admin.user.id }) });
    expect(removal.status).toBe(404);
    await env.DB.prepare("UPDATE session SET impersonatedBy='another-operator' WHERE userId=?").bind(admin.user.id).run();
    expect((await access(admin.cookie)).status).toBe(403);
  });
});
