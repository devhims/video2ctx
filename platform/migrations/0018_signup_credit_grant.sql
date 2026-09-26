-- Signup owns the current 1,000-credit Starter allowance. Keep this policy in
-- sync with STARTER_ONBOARDING_CREDITS when changing the allowance in a future migration.
-- Creating the user, balance row, and grant is one atomic database operation.
DROP TRIGGER credit_accounts_create_user;
CREATE TRIGGER credit_accounts_create_user
AFTER INSERT ON user
BEGIN
  INSERT INTO credit_accounts (user_id, available_credits) VALUES (NEW.id, 0);
  INSERT INTO credit_ledger
    (id, user_id, operation_id, entry_type, credits, metadata_json, created_at)
  VALUES (
    'onboarding:' || NEW.id, NEW.id, 'onboarding:v1', 'grant', 1000,
    '{"plan":"starter","kind":"onboarding","allowance":1000}',
    CAST(strftime('%s', 'now') AS INTEGER) * 1000
  );
END;

-- One-time catch-up for older Starter accounts that never received their grant.
-- Preserve prior grants, balances above the allowance, and Builder accounts.
INSERT OR IGNORE INTO credit_ledger
  (id, user_id, operation_id, entry_type, credits, metadata_json, created_at)
SELECT
  'onboarding:' || a.user_id, a.user_id, 'onboarding:v1', 'grant',
  MAX(1000 - a.available_credits, 0),
  '{"plan":"starter","kind":"onboarding","allowance":1000}',
  CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM credit_accounts a
LEFT JOIN billing_accounts b ON b.user_id = a.user_id
WHERE COALESCE(b.plan, 'starter') != 'builder'
  AND NOT EXISTS (
    SELECT 1 FROM credit_ledger l
    WHERE l.user_id = a.user_id AND l.operation_id = 'onboarding:v1' AND l.entry_type = 'grant'
  );
