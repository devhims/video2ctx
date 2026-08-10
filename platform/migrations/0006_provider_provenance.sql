-- Preserve provider provenance for durable source references.
-- Existing rows predate multi-provider routing and therefore belong to YouTube.
CREATE TABLE project_items_with_provider (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'youtube',
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  start_ms INTEGER,
  end_ms INTEGER,
  note TEXT NOT NULL DEFAULT '',
  tags_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  UNIQUE(project_id, provider, entity_type, entity_id, start_ms)
);

INSERT INTO project_items_with_provider (
  id, project_id, user_id, provider, entity_type, entity_id, title,
  start_ms, end_ms, note, tags_json, created_at
)
SELECT
  id, project_id, user_id, 'youtube', entity_type, entity_id, title,
  start_ms, end_ms, note, tags_json, created_at
FROM project_items;

DROP TABLE project_items;
ALTER TABLE project_items_with_provider RENAME TO project_items;
CREATE INDEX project_items_search_idx
  ON project_items(user_id, project_id, provider, entity_type, entity_id);

CREATE TABLE analytics_snapshots_with_provider (
  provider TEXT NOT NULL DEFAULT 'youtube',
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  captured_at INTEGER NOT NULL,
  view_count INTEGER,
  like_count INTEGER,
  comment_count INTEGER,
  velocity REAL,
  PRIMARY KEY(provider, entity_type, entity_id, captured_at)
);
INSERT INTO analytics_snapshots_with_provider
SELECT 'youtube', entity_type, entity_id, captured_at, view_count, like_count, comment_count, velocity
FROM analytics_snapshots;
DROP TABLE analytics_snapshots;
ALTER TABLE analytics_snapshots_with_provider RENAME TO analytics_snapshots;

CREATE TABLE monitors_with_provider (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'youtube',
  kind TEXT NOT NULL CHECK(kind IN ('channel','topic','search')),
  target TEXT NOT NULL,
  query_json TEXT NOT NULL DEFAULT '{}',
  cadence TEXT NOT NULL DEFAULT 'hourly',
  enabled INTEGER NOT NULL DEFAULT 1,
  last_checked_at INTEGER,
  last_cursor TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(user_id, provider, kind, target)
);
INSERT INTO monitors_with_provider
SELECT id, user_id, 'youtube', kind, target, query_json, cadence, enabled, last_checked_at, last_cursor, created_at
FROM monitors;
DROP TABLE monitors;
ALTER TABLE monitors_with_provider RENAME TO monitors;

ALTER TABLE documents ADD COLUMN provider TEXT NOT NULL DEFAULT 'youtube';
CREATE INDEX documents_provider_idx ON documents(provider, entity_type, entity_id);
