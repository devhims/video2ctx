-- Rebuild documents so private metadata follows its owning user and project.
-- SQLite cannot add foreign keys to an existing table with ALTER COLUMN.
CREATE TABLE documents_with_owners (
  id TEXT PRIMARY KEY,
  owner_scope TEXT NOT NULL CHECK(owner_scope IN ('public', 'private')),
  user_id TEXT REFERENCES user(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  language TEXT,
  title TEXT NOT NULL,
  body_preview TEXT NOT NULL DEFAULT '',
  r2_key TEXT NOT NULL,
  search_item_id TEXT,
  indexed_at INTEGER,
  created_at INTEGER NOT NULL,
  CHECK(
    (owner_scope = 'public' AND user_id IS NULL AND project_id IS NULL)
    OR
    (owner_scope = 'private' AND user_id IS NOT NULL AND project_id IS NOT NULL)
  )
);

INSERT INTO documents_with_owners (
  id, owner_scope, user_id, project_id, entity_type, entity_id, language,
  title, body_preview, r2_key, indexed_at, created_at
)
SELECT
  id, owner_scope, user_id, project_id, entity_type, entity_id, language,
  title, body_preview, r2_key, indexed_at, created_at
FROM documents;

DROP TABLE documents;
ALTER TABLE documents_with_owners RENAME TO documents;
CREATE INDEX documents_private_idx ON documents(user_id, project_id, entity_id);
CREATE INDEX documents_public_idx ON documents(owner_scope, entity_type, entity_id);
