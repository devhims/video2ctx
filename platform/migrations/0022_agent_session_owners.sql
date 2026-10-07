-- Locates a session's owner for admin debugging. Owner reads never consult it.
-- Session UUIDs are caller-supplied, so one ID can belong to more than one account.
CREATE TABLE agent_session_owners (
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, user_id)
);
CREATE INDEX agent_session_owners_user_idx ON agent_session_owners(user_id);

-- Seeds every traced session. Older untraced sessions stay out of admin debugging.
INSERT OR IGNORE INTO agent_session_owners (session_id, user_id, created_at)
SELECT session_id, user_id, MIN(started_at) FROM agent_trace_runs GROUP BY session_id, user_id;
