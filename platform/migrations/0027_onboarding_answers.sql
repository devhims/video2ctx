-- Answers from the dashboard's first-visit onboarding, one row per account.
-- `agents` is a JSON array of coding-agent ids in a fixed order, for example
-- '["claude-code","codex"]'. Count accounts per agent with:
--   SELECT value AS agent, COUNT(*) FROM onboarding_answers, json_each(agents) GROUP BY value;
-- Answers go with the account: deleting the user removes the row.
CREATE TABLE onboarding_answers (
  user_id TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
  agents TEXT NOT NULL CHECK (json_valid(agents) AND json_type(agents) = 'array' AND json_array_length(agents) > 0),
  goal TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
