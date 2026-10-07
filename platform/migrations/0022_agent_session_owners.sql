-- Locates a session's owner for admin debugging. Owner reads never consult it.
-- Session UUIDs are caller-supplied, so one ID can belong to more than one account.
CREATE TABLE agent_session_owners (
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, user_id)
);
CREATE INDEX agent_session_owners_user_idx ON agent_session_owners(user_id);

-- Sessions with a diagnostic trace are indexed immediately.
INSERT OR IGNORE INTO agent_session_owners (session_id, user_id, created_at)
SELECT session_id, user_id, MIN(started_at) FROM agent_trace_runs GROUP BY session_id, user_id;

-- The hourly cron indexes the remaining older sessions from account catalogs.
CREATE TABLE agent_session_owner_backfill (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  after_user_id TEXT NOT NULL DEFAULT '',
  completed_at INTEGER
);
INSERT INTO agent_session_owner_backfill (id) VALUES (1);
