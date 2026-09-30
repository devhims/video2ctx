-- Administrative diagnostic index. Payloads remain private R2 objects.
CREATE TABLE agent_tool_traces (
  trace_id TEXT PRIMARY KEY,
  call_sequence INTEGER NOT NULL,
  result_sequence INTEGER,
  attempt INTEGER NOT NULL,
  run_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  operation TEXT NOT NULL,
  source TEXT NOT NULL,
  run_status TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  input_key TEXT,
  output_key TEXT,
  error_key TEXT,
  capture_error TEXT,
  deleted INTEGER NOT NULL DEFAULT 0,
  index_version INTEGER NOT NULL,
  UNIQUE (run_id, tool_call_id, attempt)
);
CREATE INDEX agent_tool_traces_recent_idx ON agent_tool_traces (started_at DESC, run_id);
CREATE INDEX agent_tool_traces_owner_idx ON agent_tool_traces (user_id, started_at DESC);
CREATE INDEX agent_tool_traces_session_idx ON agent_tool_traces (session_id, started_at DESC);
