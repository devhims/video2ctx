/**
 * Admin debugging lookup only, written after admission responds. Owner reads
 * never consult it, so a failed write hides one link from admins and nothing else.
 */
export async function indexSessionOwner(env: Env, userId: string, sessionId: string): Promise<void> {
  try {
    // Selecting from user skips an account deleted since admission.
    await env.DB.prepare(`INSERT OR IGNORE INTO agent_session_owners (session_id, user_id, created_at)
      SELECT ?, id, ? FROM user WHERE id = ?`).bind(sessionId, Date.now(), userId).run();
  } catch {
    console.error({ event: 'agent_session_owner_index_failed', sessionId });
  }
}

/** Other accounts that hold this session ID, at most two so ambiguity is visible. */
export async function otherSessionOwners(env: Env, sessionId: string, viewerId: string): Promise<string[]> {
  const rows = await env.DB.prepare('SELECT user_id FROM agent_session_owners WHERE session_id = ? AND user_id <> ? LIMIT 2')
    .bind(sessionId, viewerId).all<{ user_id: string }>();
  return rows.results.map(row => row.user_id);
}
