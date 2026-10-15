-- Keep payment problems when customer.state_changed omits inactive subscriptions.
-- This projection controls billing navigation only, never entitlements or credits.
CREATE TABLE billing_subscription_states (
  subscription_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  customer_id TEXT NOT NULL,
  status TEXT NOT NULL,
  provider_updated_at INTEGER NOT NULL
);
CREATE INDEX billing_subscription_states_owner_status_idx
  ON billing_subscription_states(user_id, status);

INSERT INTO billing_subscription_states
  (subscription_id,user_id,customer_id,status,provider_updated_at)
SELECT provider_subscription_id,user_id,provider_customer_id,status,provider_updated_at
FROM billing_accounts
WHERE provider_subscription_id IS NOT NULL AND provider_customer_id IS NOT NULL
  -- Refund and inactive are account states, not a current subscription status.
  AND status IN ('incomplete','incomplete_expired','trialing','active','past_due','canceled','unpaid');
