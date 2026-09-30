-- One searchable summary per run. Call rows may publish independently.
CREATE TABLE agent_trace_runs (
  run_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  call_count INTEGER NOT NULL,
  failed_calls INTEGER NOT NULL,
  capture_failures INTEGER NOT NULL,
  index_version INTEGER NOT NULL
);
CREATE INDEX agent_trace_runs_recent_idx ON agent_trace_runs(started_at DESC,run_id DESC);
CREATE INDEX agent_trace_runs_status_idx ON agent_trace_runs(status,started_at DESC,run_id DESC);
CREATE INDEX agent_trace_runs_user_idx ON agent_trace_runs(user_id,started_at DESC,run_id DESC);
CREATE INDEX agent_trace_runs_session_idx ON agent_trace_runs(session_id,started_at DESC,run_id DESC);
-- Preserve visibility if the initial trace migration has already been used.
-- Terminal status wins over call rows whose status publication was delayed.
INSERT INTO agent_trace_runs
SELECT run_id,user_id,session_id,
  COALESCE(MAX(CASE WHEN run_status IN ('completed','failed','cancelled') THEN run_status END),MAX(run_status)),
  MIN(started_at),MAX(COALESCE(finished_at,started_at)),COUNT(*),
  SUM(status='failed'),SUM(capture_error IS NOT NULL),0
FROM agent_tool_traces GROUP BY run_id,user_id,session_id;
