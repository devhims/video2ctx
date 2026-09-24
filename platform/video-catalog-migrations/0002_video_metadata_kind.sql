-- Rename get-video-details assets without moving immutable R2 payloads.
UPDATE video_assets SET kind = 'video_metadata' WHERE kind = 'video';
UPDATE video_asset_versions SET kind = 'video_metadata' WHERE kind = 'video';
