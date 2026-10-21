import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import { deleteAdminUser, type AdminUser } from './admin-users.ts';

const user = { id: 'target-user', email: 'target@example.test' } as AdminUser;
const pending = () => Response.json({ error: { code: 'ACCOUNT_DELETION_IN_PROGRESS', message: 'Deletion is running.' } }, { status: 409 });

for (const first of ['in_progress', 'gateway_timeout', 'lost_connection'] as const) {
  test(`waits for deletion completion after ${first}`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
      assert.equal(init.method, 'DELETE');
      assert.deepEqual(JSON.parse(String(init.body)), { email: user.email });
      calls++;
      if (calls === 1 && first === 'gateway_timeout') return new Response(null, { status: 504 });
      if (calls === 1 && first === 'lost_connection') throw new TypeError('Failed to fetch');
      return calls < 3 ? pending() : new Response(null, { status: 204 });
    });
    let finished = false;
    const messages: string[] = [];
    const result = deleteAdminUser(user, { onProgress: message => messages.push(message) }).then(() => { finished = true; });
    // Attach a rejection observer before advancing timers.
    const verified = assert.doesNotReject(result);
    await setImmediate();
    assert.equal(finished, false);
    for (let i = 0; i < 2; i++) { t.mock.timers.tick(2000); await setImmediate(); }
    await verified;
    assert.equal(calls, 3);
    assert.equal(finished, true);
    assert.equal(messages.length, 2);
    assert.match(messages.at(-1)!, /still running/);
  });
}

test('stops retrying when the admin leaves the page', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const controller = new AbortController();
  const fetch = t.mock.method(globalThis, 'fetch', async () => pending());
  const result = deleteAdminUser(user, { signal: controller.signal });
  const rejected = assert.rejects(result, { name: 'AbortError' });
  await setImmediate();
  controller.abort();
  await rejected;
  t.mock.timers.tick(10_000);
  assert.equal(fetch.mock.callCount(), 1);
});

test('bounds waiting without claiming an unfinished deletion succeeded', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const fetch = t.mock.method(globalThis, 'fetch', async () => pending());
  const result = deleteAdminUser(user);
  const rejected = assert.rejects(result, /not been confirmed yet/);
  await setImmediate();
  t.mock.timers.tick(120_000);
  await rejected;
  assert.equal(fetch.mock.callCount(), 2);
});

for (const code of ['BILLING_OPERATION_PENDING', 'SUBSCRIPTION_ACTIVE', 'USER_IDENTITY_CHANGED', 'ACCOUNT_DELETION_INCOMPLETE']) {
  test(`does not silently retry ${code}`, async t => {
    const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ error: { code, message: 'Needs attention.' } }, { status: code === 'ACCOUNT_DELETION_INCOMPLETE' ? 503 : 409 }));
    await assert.rejects(deleteAdminUser(user), { code });
    assert.equal(fetch.mock.callCount(), 1);
  });
}
