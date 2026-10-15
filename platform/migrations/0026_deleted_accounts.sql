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

-- The audit snapshot never changes. Spendable carryover and its one-time
-- successor claim are separate, durable state, independent of current emails.
CREATE TABLE account_credit_carryovers (
  user_id TEXT PRIMARY KEY REFERENCES deleted_accounts(user_id),
  available_credits INTEGER NOT NULL,
  transferred_to_user_id TEXT UNIQUE,
  billing_status TEXT NOT NULL,
  credit_updated_at INTEGER NOT NULL
);
CREATE TABLE account_credit_refunds (
  order_id TEXT PRIMARY KEY,
  original_user_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('applied','superseded','unfunded')),
  event_at INTEGER NOT NULL
);
CREATE INDEX account_credit_refunds_owner ON account_credit_refunds (owner_user_id, event_at);
CREATE TABLE account_credit_payments (
  order_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  event_at INTEGER NOT NULL,
  event_exact INTEGER NOT NULL CHECK (event_exact IN (0,1)),
  observed_at INTEGER NOT NULL
);
CREATE INDEX account_credit_payments_user ON account_credit_payments (user_id, event_at);
CREATE INDEX deleted_accounts_polar_customer ON deleted_accounts (polar_customer_id);

-- Old grants did not retain Polar's event timestamp. Keep the actual grant
-- and its observation time, not a later cancellation's provider_updated_at.
-- A signed order.paid replay can fill in the exact timestamp even after deletion.
INSERT INTO account_credit_payments (order_id,user_id,customer_id,event_at,event_exact,observed_at)
SELECT substr(l.operation_id,13),l.user_id,b.provider_customer_id,
  COALESCE(json_extract(l.metadata_json,'$.providerEventAt'),0),
  CASE WHEN json_extract(l.metadata_json,'$.providerEventAt') IS NULL THEN 0 ELSE 1 END,l.created_at
FROM credit_ledger l JOIN billing_accounts b ON b.user_id=l.user_id
WHERE l.entry_type='grant' AND l.operation_id GLOB 'polar:order:*'
  AND b.provider_customer_id IS NOT NULL;

-- Applied legacy refunds must also survive a subsequent deletion.
INSERT INTO account_credit_refunds (order_id,original_user_id,customer_id,owner_user_id,outcome,event_at)
SELECT substr(l.operation_id,14),l.user_id,b.provider_customer_id,l.user_id,'applied',0
FROM credit_ledger l JOIN billing_accounts b ON b.user_id=l.user_id
WHERE l.entry_type='adjustment'
  AND l.operation_id GLOB 'polar:refund:*' AND b.provider_customer_id IS NOT NULL
ON CONFLICT(order_id) DO NOTHING;

-- Also capture writes by the old Worker between migration and deployment.
CREATE TRIGGER account_credit_payments_capture_grant
AFTER INSERT ON credit_ledger
WHEN NEW.entry_type='grant' AND NEW.operation_id GLOB 'polar:order:*'
BEGIN
  INSERT INTO account_credit_payments (order_id,user_id,customer_id,event_at,event_exact,observed_at)
  SELECT substr(NEW.operation_id,13),NEW.user_id,b.provider_customer_id,
    COALESCE(json_extract(NEW.metadata_json,'$.providerEventAt'),0),
    CASE WHEN json_extract(NEW.metadata_json,'$.providerEventAt') IS NULL THEN 0 ELSE 1 END,NEW.created_at
  FROM billing_accounts b WHERE b.user_id=NEW.user_id AND b.provider_customer_id IS NOT NULL
  ON CONFLICT(order_id) DO NOTHING;
END;

CREATE TRIGGER deleted_accounts_create_carryover
AFTER INSERT ON deleted_accounts
BEGIN
  -- Preserve any legacy grant still present when this account is deleted.
  INSERT INTO account_credit_payments (order_id,user_id,customer_id,event_at,event_exact,observed_at)
  SELECT substr(l.operation_id,13),l.user_id,b.provider_customer_id,
    COALESCE(json_extract(l.metadata_json,'$.providerEventAt'),0),
    CASE WHEN json_extract(l.metadata_json,'$.providerEventAt') IS NULL THEN 0 ELSE 1 END,l.created_at
  FROM credit_ledger l JOIN billing_accounts b ON b.user_id=l.user_id
  WHERE l.entry_type='grant' AND l.operation_id GLOB 'polar:order:*'
    AND b.provider_customer_id IS NOT NULL AND l.user_id=NEW.user_id
  ON CONFLICT(order_id) DO NOTHING;
  INSERT INTO account_credit_carryovers (user_id,available_credits,billing_status,credit_updated_at)
  SELECT NEW.user_id,NEW.remaining_credits,COALESCE(b.status,'inactive'),
    COALESCE((SELECT MAX(event_at) FROM account_credit_payments WHERE user_id=NEW.user_id AND event_exact=1),0)
  FROM (SELECT 1) LEFT JOIN billing_accounts b ON b.user_id=NEW.user_id;
  -- Preserve refund idempotency from pre-ledger Workers before the ledger
  -- cascades away. Unknown provider timestamps are not ordering fences.
  INSERT INTO account_credit_refunds (order_id,original_user_id,customer_id,owner_user_id,outcome,event_at)
  SELECT substr(l.operation_id,14),NEW.user_id,b.provider_customer_id,NEW.user_id,'applied',0
  FROM credit_ledger l JOIN billing_accounts b ON b.user_id=l.user_id
  WHERE l.user_id=NEW.user_id AND l.entry_type='adjustment'
    AND l.operation_id GLOB 'polar:refund:*' AND b.provider_customer_id IS NOT NULL
  ON CONFLICT(order_id) DO NOTHING;
END;

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
  -- Claim the newest snapshot once, before reading its spendable balance.
  -- A renamed successor retains this claim; another signup on the old email
  -- receives zero rather than reusing an already transferred snapshot.
  UPDATE account_credit_carryovers SET transferred_to_user_id=NEW.id
  WHERE user_id=(SELECT user_id FROM deleted_accounts WHERE email=lower(trim(NEW.email))
    ORDER BY sequence DESC LIMIT 1) AND transferred_to_user_id IS NULL;
  INSERT INTO credit_ledger
    (id,user_id,operation_id,entry_type,credits,metadata_json,created_at)
  SELECT 'onboarding:' || NEW.id,NEW.id,
    CASE WHEN EXISTS (SELECT 1 FROM deleted_accounts WHERE email=lower(trim(NEW.email)))
      THEN 'returning-account:v1' ELSE 'onboarding:v1' END,
    CASE WHEN EXISTS (SELECT 1 FROM deleted_accounts WHERE email=lower(trim(NEW.email)))
      THEN 'adjustment' ELSE 'grant' END,
    CASE WHEN EXISTS (SELECT 1 FROM deleted_accounts WHERE email=lower(trim(NEW.email)))
      THEN COALESCE((SELECT available_credits FROM account_credit_carryovers WHERE transferred_to_user_id=NEW.id),0)
      ELSE 1000 END,
    CASE WHEN EXISTS (SELECT 1 FROM deleted_accounts WHERE email=lower(trim(NEW.email)))
      THEN '{"kind":"returning-account"}'
      ELSE '{"plan":"starter","kind":"onboarding","allowance":1000}' END,
    CAST(strftime('%s','now') AS INTEGER)*1000;
END;
