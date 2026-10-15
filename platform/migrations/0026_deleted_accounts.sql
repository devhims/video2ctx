-- Deliberately retained after account cleanup for support and repeat-signup
-- credit continuity. No FK to user: each deletion is a separate historical row.
CREATE TABLE deleted_accounts (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  signed_up_at INTEGER NOT NULL,
  deleted_at INTEGER NOT NULL,
  polar_customer_id TEXT,
  plan TEXT NOT NULL CHECK (plan IN ('starter', 'builder')),
  remaining_credits INTEGER NOT NULL,
  deletion_source TEXT NOT NULL CHECK (deletion_source IN ('self', 'admin', 'database')),
  deleted_by_user_id TEXT
);
CREATE INDEX deleted_accounts_email_history ON deleted_accounts (email, sequence DESC);

-- Capture the spendable balance before FK cascades remove the credit ledger.
-- API cleanup supplies the actor in its transaction. Older Workers and direct
-- D1 deletes still preserve the history, labelled as a database deletion.
CREATE TRIGGER deleted_accounts_capture_user
BEFORE DELETE ON user
BEGIN
  INSERT INTO deleted_accounts
    (user_id,email,signed_up_at,deleted_at,polar_customer_id,plan,remaining_credits,deletion_source)
  SELECT OLD.id,lower(trim(OLD.email)),OLD.createdAt,
    CAST(strftime('%s','now') AS INTEGER)*1000,b.provider_customer_id,
    COALESCE(b.plan,'starter'),COALESCE(a.available_credits,0),'database'
  FROM user u LEFT JOIN credit_accounts a ON a.user_id=u.id
    LEFT JOIN billing_accounts b ON b.user_id=u.id WHERE u.id=OLD.id
  ON CONFLICT(user_id) DO NOTHING;
END;

-- An old ID must never resurrect deleted sessions. Email matching is literal,
-- case-insensitive and whitespace-trimmed, without guessing provider aliases.
CREATE TRIGGER credit_accounts_check_signup
BEFORE INSERT ON user
BEGIN
  SELECT RAISE(ABORT, 'Deleted user IDs cannot be reused')
    WHERE EXISTS (SELECT 1 FROM deleted_accounts WHERE user_id=NEW.id);
  SELECT RAISE(ABORT, 'An account already exists for this email')
    WHERE EXISTS (SELECT 1 FROM user WHERE lower(trim(email))=lower(trim(NEW.email)) AND id<>NEW.id);
END;

DROP TRIGGER credit_accounts_create_user;
CREATE TRIGGER credit_accounts_create_user
AFTER INSERT ON user
BEGIN
  INSERT INTO credit_accounts (user_id, available_credits) VALUES (NEW.id, 0);
  INSERT INTO credit_ledger
    (id,user_id,operation_id,entry_type,credits,metadata_json,created_at)
  SELECT 'onboarding:' || NEW.id,NEW.id,
    CASE WHEN EXISTS (SELECT 1 FROM deleted_accounts WHERE email=lower(trim(NEW.email)))
      THEN 'returning-account:v1' ELSE 'onboarding:v1' END,
    CASE WHEN EXISTS (SELECT 1 FROM deleted_accounts WHERE email=lower(trim(NEW.email)))
      THEN 'adjustment' ELSE 'grant' END,
    COALESCE((SELECT remaining_credits FROM deleted_accounts WHERE email=lower(trim(NEW.email))
      ORDER BY sequence DESC LIMIT 1),1000),
    CASE WHEN EXISTS (SELECT 1 FROM deleted_accounts WHERE email=lower(trim(NEW.email)))
      THEN '{"kind":"returning-account"}'
      ELSE '{"plan":"starter","kind":"onboarding","allowance":1000}' END,
    CAST(strftime('%s','now') AS INTEGER)*1000;
END;
