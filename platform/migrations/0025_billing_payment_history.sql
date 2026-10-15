-- A valid payment remains history even when a newer account snapshot blocks
-- its credit adjustment. Customer snapshots never clear this flag.
ALTER TABLE billing_accounts ADD COLUMN has_payment_history INTEGER NOT NULL DEFAULT 0
  CHECK(has_payment_history IN (0, 1));

UPDATE billing_accounts SET has_payment_history=1
WHERE EXISTS (
  SELECT 1 FROM credit_ledger WHERE user_id=billing_accounts.user_id
    AND (operation_id GLOB 'polar:order:*' OR operation_id GLOB 'polar:refund:*')
);
