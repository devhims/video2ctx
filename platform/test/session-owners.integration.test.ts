import { env as workerEnv } from 'cloudflare:test';
import { expect, test } from 'vitest';
import { userAccountInstanceName } from '../src/agents/runtime/identity';
import { backfillSessionOwners, indexSessionOwner, otherSessionOwners } from '../src/lib/session-owners';

const env = workerEnv as Env;

async function user(id: string) {
  await env.DB.prepare('INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,?,?,?)')
    .bind(id, 'Test', `${id}@test.local`, 1, Date.now(), Date.now()).run();
}

async function catalogSession(userId: string, conversationId: string, updatedAt: number) {
  const account = env.USER_ACCOUNT.getByName(await userAccountInstanceName(userId));
  await account.recordSession({ conversationId, runId: crypto.randomUUID(), message: 'Older session', updatedAt });
}

async function owners() {
  return (await env.DB.prepare('SELECT session_id, user_id, created_at FROM agent_session_owners ORDER BY user_id, session_id')
    .all<{ session_id: string; user_id: string; created_at: number }>()).results;
}

test('backfill pages through account catalogs, resumes from its cursor and then stops', async () => {
  const [a, b] = [crypto.randomUUID(), crypto.randomUUID()];
  await Promise.all(['backfill-a', 'backfill-b', 'backfill-c'].map(user));
  await catalogSession('backfill-a', a, 100);
  await catalogSession('backfill-c', b, 200);
  await env.DB.prepare('UPDATE agent_session_owner_backfill SET after_user_id = ?, completed_at = NULL WHERE id = 1').bind('').run();

  await backfillSessionOwners(env, 2);
  expect(await owners()).toEqual([{ session_id: a, user_id: 'backfill-a', created_at: 100 }]);
  expect(await env.DB.prepare('SELECT after_user_id AS after, completed_at AS completedAt FROM agent_session_owner_backfill').first())
    .toEqual({ after: 'backfill-b', completedAt: null });

  await backfillSessionOwners(env, 2);
  expect(await owners()).toEqual([
    { session_id: a, user_id: 'backfill-a', created_at: 100 },
    { session_id: b, user_id: 'backfill-c', created_at: 200 },
  ]);
  const state = await env.DB.prepare('SELECT completed_at AS completedAt FROM agent_session_owner_backfill').first<{ completedAt: number | null }>();
  expect(state?.completedAt).toEqual(expect.any(Number));

  await catalogSession('backfill-b', crypto.randomUUID(), 300);
  await backfillSessionOwners(env, 2);
  expect(await owners()).toHaveLength(2);
});

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
