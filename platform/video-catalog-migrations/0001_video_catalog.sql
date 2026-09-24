-- The catalog contains public provider evidence only. User questions and derived
-- session analysis remain in the session evidence store.
CREATE TABLE videos (
  video_id TEXT PRIMARY KEY COLLATE BINARY,
  first_requested_at INTEGER NOT NULL,
  last_requested_at INTEGER NOT NULL
);

-- Immutable payload inventory doubles as a recoverable write journal. R2 is
-- written before a current pointer is published. Pending writes are reconciled.
CREATE TABLE video_asset_versions (
  video_id TEXT NOT NULL REFERENCES videos(video_id),
  kind TEXT NOT NULL,
  variant TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  object_key TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  fetched_at INTEGER NOT NULL,
  fresh_until INTEGER NOT NULL,
  complete INTEGER NOT NULL CHECK (complete IN (0, 1)),
  coverage_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'ready')),
  PRIMARY KEY (video_id, kind, variant, content_hash)
);
CREATE INDEX video_asset_pending_idx ON video_asset_versions(state, fetched_at);

CREATE TABLE video_assets (
  video_id TEXT NOT NULL REFERENCES videos(video_id),
  kind TEXT NOT NULL,
  variant TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  object_key TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  fresh_until INTEGER NOT NULL,
  complete INTEGER NOT NULL CHECK (complete IN (0, 1)),
  coverage_json TEXT NOT NULL,
  PRIMARY KEY (video_id, kind, variant)
);
