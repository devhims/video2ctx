-- Terminal run error, so runs that end before any tool call remain diagnosable.
-- Rows written before this migration keep NULL.
ALTER TABLE agent_trace_runs ADD COLUMN error TEXT;
