import { env as workerEnv } from 'cloudflare:test';
import { expect, test } from 'vitest';
import { indexSessionOwner, otherSessionOwners } from '../src/lib/session-owners';

const env = workerEnv as Env;

async function user(id: string) {
  await env.DB.prepare('INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,?,?,?)')
    .bind(id, 'Test', `${id}@test.local`, 1, Date.now(), Date.now()).run();
}

test('admission indexing is idempotent, skips deleted accounts and exposes collisions', async () => {
  const sessionId = crypto.randomUUID();
  await Promise.all(['index-a', 'index-b'].map(user));
  await indexSessionOwner(env, 'index-a', sessionId);
  await indexSessionOwner(env, 'index-a', sessionId);
  await indexSessionOwner(env, 'index-missing', sessionId);
  expect(await otherSessionOwners(env, sessionId, 'viewer')).toEqual(['index-a']);
  expect(await otherSessionOwners(env, sessionId, 'index-a')).toEqual([]);

  await indexSessionOwner(env, 'index-b', sessionId);
  expect((await otherSessionOwners(env, sessionId, 'viewer')).sort()).toEqual(['index-a', 'index-b']);
  await env.DB.prepare('DELETE FROM user WHERE id = ?').bind('index-b').run();
  expect(await otherSessionOwners(env, sessionId, 'viewer')).toEqual(['index-a']);
});
