-- Earlier dashboard builds stored video-channel watches as topic monitors even
-- though the target was a YouTube channel ID. Restore their intended kind so
-- the hourly workflow reads the channel's upload feed instead of searching the
-- opaque ID as text.
DELETE FROM monitors
WHERE provider = 'youtube'
  AND kind = 'topic'
  AND length(target) = 24
  AND substr(target, 1, 2) = 'UC'
  AND EXISTS (
    SELECT 1 FROM monitors AS channel_monitor
    WHERE channel_monitor.user_id = monitors.user_id
      AND channel_monitor.provider = monitors.provider
      AND channel_monitor.kind = 'channel'
      AND channel_monitor.target = monitors.target
  );

UPDATE monitors
SET kind = 'channel'
WHERE provider = 'youtube'
  AND kind = 'topic'
  AND length(target) = 24
  AND substr(target, 1, 2) = 'UC';
