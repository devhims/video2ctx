-- Immediate monitor emails are independent from in-app alerts and legacy
-- daily/weekly digests. Existing users may opt out from Settings.
ALTER TABLE notification_preferences ADD COLUMN email_alerts INTEGER NOT NULL DEFAULT 1
  CHECK(email_alerts IN (0, 1));

-- Preserve the intent of people who previously used an unsubscribe link.
UPDATE notification_preferences SET email_alerts=0 WHERE unsubscribed_at IS NOT NULL;
