-- Terminal identity conflicts require explicit payment reconciliation. No credits
-- or plan changes are applied to either account from these events.
CREATE TABLE polar_billing_conflicts (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  order_id TEXT,
  customer_id TEXT NOT NULL,
  subscription_id TEXT,
  checkout_user_id TEXT,
  customer_user_id TEXT,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE INDEX polar_billing_conflicts_pending_customer_idx
  ON polar_billing_conflicts(customer_id, created_at) WHERE resolved_at IS NULL;
