import { userAccountInstanceName } from '../agents/runtime/identity';
import { mapInBatches } from './map-in-batches';

export const SESSION_OWNER_BACKFILL_USERS = 200;

export interface SessionOwnerEntry { conversationId: string; createdAt: number }

/**
 * Admin debugging lookup only. Owner reads never consult this index, so a
 * missed write hides one link from admins and nothing else.
 */
function sessionOwnerStatement(env: Env, userId: string, sessions: SessionOwnerEntry[]): D1PreparedStatement {
  // Joining user skips accounts deleted since the session was created.
  return env.DB.prepare(`INSERT OR IGNORE INTO agent_session_owners (session_id, user_id, created_at)
    SELECT json_extract(value, '$.conversationId'), user.id, json_extract(value, '$.createdAt')
    FROM json_each(?) JOIN user ON user.id = ?`).bind(JSON.stringify(sessions), userId);
}

/** Runs after admission responds. Failures are logged, never surfaced to the caller. */
export async function indexSessionOwner(env: Env, userId: string, conversationId: string): Promise<void> {
  try {
    await sessionOwnerStatement(env, userId, [{ conversationId, createdAt: Date.now() }]).run();
  } catch {
    console.error({ event: 'agent_session_owner_index_failed', sessionId: conversationId });
  }
}

/** Other accounts that hold this session ID, at most two so ambiguity is visible. */
export async function otherSessionOwners(env: Env, sessionId: string, viewerId: string): Promise<string[]> {
  const rows = await env.DB.prepare('SELECT user_id FROM agent_session_owners WHERE session_id = ? AND user_id <> ? LIMIT 2')
    .bind(sessionId, viewerId).all<{ user_id: string }>();
  return rows.results.map(row => row.user_id);
}

/**
 * Indexes sessions created before admission recorded owners. Each hourly run
 * advances a durable cursor by one page of users until the catalog is covered.
 */
export async function backfillSessionOwners(env: Env, limit = SESSION_OWNER_BACKFILL_USERS): Promise<void> {
  const state = await env.DB.prepare('SELECT after_user_id AS after, completed_at AS completedAt FROM agent_session_owner_backfill WHERE id = 1')
    .first<{ after: string; completedAt: number | null }>();
  if (!state || state.completedAt !== null) return;
  const users = await env.DB.prepare('SELECT id FROM user WHERE id > ? ORDER BY id LIMIT ?').bind(state.after, limit).all<{ id: string }>();
  const statements = await mapInBatches(users.results, async ({ id }) => {
    try {
      const account = env.USER_ACCOUNT.getByName(await userAccountInstanceName(id));
      const sessions = await account.listSessionOwnerEntries();
      return sessions.length ? sessionOwnerStatement(env, id, sessions) : null;
    } catch {
      // One unreadable account must not stall the cursor for everyone else.
      console.error({ event: 'agent_session_owner_backfill_account_failed', userId: id });
      return null;
    }
  });
  const done = users.results.length < limit;
  await env.DB.batch([
    ...statements.filter((statement): statement is D1PreparedStatement => statement !== null),
    env.DB.prepare('UPDATE agent_session_owner_backfill SET after_user_id = ?, completed_at = ? WHERE id = 1')
      .bind(users.results.at(-1)?.id ?? state.after, done ? Date.now() : null),
  ]);
}
