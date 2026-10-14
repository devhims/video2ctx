-- Written before a checkout request reaches Polar. Hosted checkout can create a
-- Polar customer before its webhook writes billing_accounts, and that webhook can
-- be delayed or fail, so account deletion treats either row as evidence that the
-- Polar customer must be cleaned up.
CREATE TABLE billing_checkout_intents (
  user_id TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
