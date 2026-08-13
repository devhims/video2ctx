-- Monitor email alerts require an explicit, verified opt-in. A pending request
-- records when the user asked for the confirmation message; delivery remains
-- disabled until that request is confirmed from the signed-in dashboard.
ALTER TABLE notification_preferences ADD COLUMN email_alerts_requested_at INTEGER;
ALTER TABLE notification_preferences ADD COLUMN email_alerts_verified_at INTEGER;

-- Earlier builds treated a missing preference as consent and briefly exposed
-- an enabled-by-default toggle. Reset that state so nobody receives monitor
-- email until they complete the new confirmation flow.
UPDATE notification_preferences
SET email_alerts = 0,
    email_digest = 'off',
    email_alerts_requested_at = NULL,
    email_alerts_verified_at = NULL;
