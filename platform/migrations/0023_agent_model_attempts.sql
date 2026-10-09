-- One row per finished model attempt, for latency and stall analysis across runs.
-- Rows hold identifiers, timings and token counts only, never prompts or output.
CREATE TABLE agent_model_attempts (
  attempt_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  call_id TEXT NOT NULL,
  role TEXT NOT NULL,
  model_id TEXT NOT NULL,
  service_tier TEXT,
  outcome TEXT NOT NULL,
  reason TEXT,
  started_at INTEGER NOT NULL,
  -- First text, reasoning or tool-argument delta. NULL when none arrived.
  first_content_ms INTEGER,
  -- Time to completion, or to failure or cancellation.
  elapsed_ms INTEGER NOT NULL,
  input_tokens INTEGER,
  cached_input_tokens INTEGER,
  output_tokens INTEGER,
  reasoning_tokens INTEGER,
  status_code INTEGER,
  provider_request_id TEXT,
  first_content_timeout_ms INTEGER,
  total_timeout_ms INTEGER
);
CREATE INDEX agent_model_attempts_run_idx ON agent_model_attempts(run_id,started_at);
CREATE INDEX agent_model_attempts_model_idx ON agent_model_attempts(model_id,role,started_at DESC);
CREATE INDEX agent_model_attempts_recent_idx ON agent_model_attempts(started_at DESC);
