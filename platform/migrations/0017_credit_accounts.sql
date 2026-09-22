-- The ledger remains the history of every credit change. This table is its
-- synchronously maintained balance, never an independently writable allowance.
CREATE TABLE credit_accounts (
  user_id TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
  available_credits INTEGER NOT NULL DEFAULT 0
);

-- Preserve the exact existing balance, including outstanding reservations and
-- any historical negative balances. Users without ledger entries start at zero.
INSERT INTO credit_accounts (user_id, available_credits)
SELECT u.id, COALESCE(SUM(l.credits), 0)
FROM user AS u
LEFT JOIN credit_ledger AS l ON l.user_id = u.id
GROUP BY u.id;

CREATE TRIGGER credit_accounts_create_user
AFTER INSERT ON user
BEGIN
  INSERT INTO credit_accounts (user_id, available_credits) VALUES (NEW.id, 0);
END;

-- AFTER INSERT fires only for a newly inserted entry, so ignored duplicate
-- operations cannot change the balance. Trigger failure rolls back the entry.
CREATE TRIGGER credit_accounts_insert_ledger
AFTER INSERT ON credit_ledger
BEGIN
  SELECT RAISE(ABORT, 'Missing credit account')
  WHERE NOT EXISTS (SELECT 1 FROM credit_accounts WHERE user_id = NEW.user_id);
  UPDATE credit_accounts
  SET available_credits = available_credits + NEW.credits
  WHERE user_id = NEW.user_id;
END;

-- Application writes append adjustments instead of editing history. Keep the
-- projection consistent for maintenance SQL and existing deletion workflows too.
CREATE TRIGGER credit_accounts_update_ledger
AFTER UPDATE OF user_id, credits ON credit_ledger
BEGIN
  SELECT RAISE(ABORT, 'Missing credit account')
  WHERE NOT EXISTS (SELECT 1 FROM credit_accounts WHERE user_id = NEW.user_id);
  UPDATE credit_accounts
  SET available_credits = available_credits - OLD.credits
  WHERE user_id = OLD.user_id;
  UPDATE credit_accounts
  SET available_credits = available_credits + NEW.credits
  WHERE user_id = NEW.user_id;
END;

CREATE TRIGGER credit_accounts_delete_ledger
AFTER DELETE ON credit_ledger
BEGIN
  UPDATE credit_accounts
  SET available_credits = available_credits - OLD.credits
  WHERE user_id = OLD.user_id;
END;
