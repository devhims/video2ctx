-- Product Hunt launch offer. Only accounts created after this migration receive it.
-- End the offer with a new migration restoring 1000; do not rewrite existing grants.
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
      ELSE 5000 END,
    CASE WHEN EXISTS (SELECT 1 FROM deleted_accounts WHERE email=lower(trim(NEW.email)))
      THEN '{"kind":"returning-account"}'
      ELSE '{"plan":"starter","kind":"onboarding","allowance":5000,"offer":"product-hunt-launch-2026"}' END,
    CAST(strftime('%s','now') AS INTEGER)*1000;
END;
