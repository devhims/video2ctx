-- Agent testing access is independent of the administrative email secret.
-- Emails can be invited before an account exists. Delete the row to revoke a D1 grant.
CREATE TABLE agent_access_allowlist (
  email TEXT PRIMARY KEY NOT NULL CHECK (length(trim(email)) > 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

-- Match direct D1 inserts regardless of case or surrounding whitespace.
CREATE UNIQUE INDEX agent_access_allowlist_email_idx
  ON agent_access_allowlist(lower(trim(email)));
