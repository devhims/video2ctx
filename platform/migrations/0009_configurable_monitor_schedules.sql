-- Durable Object alarms own each monitor's schedule. Existing hourly watches
-- move to the new 24-hour default and are picked up by the repair cron.
ALTER TABLE monitors ADD COLUMN interval_minutes INTEGER NOT NULL DEFAULT 1440
  CHECK(interval_minutes IN (60, 360, 720, 1440, 4320, 10080));
ALTER TABLE monitors ADD COLUMN next_check_at INTEGER;

UPDATE monitors SET cadence = 'daily';

CREATE INDEX monitors_schedule_idx ON monitors(enabled, next_check_at);
