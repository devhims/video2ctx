-- A session backfill must retain its historical payload without advancing the
-- public current pointer, including when reconciliation finishes a crashed write.
ALTER TABLE video_asset_versions ADD COLUMN publish_current INTEGER NOT NULL DEFAULT 1
  CHECK (publish_current IN (0, 1));
