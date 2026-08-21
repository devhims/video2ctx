PRAGMA foreign_keys = ON;

-- Application-owned projection of billing state. Polar remains the payment
-- system of record; this table is the local state used for authorization and UI.
CREATE TABLE billing_accounts (
  user_id TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'polar' CHECK(provider IN ('polar')),
  provider_customer_id TEXT UNIQUE,
  provider_subscription_id TEXT UNIQUE,
  provider_product_id TEXT,
  plan TEXT NOT NULL DEFAULT 'starter' CHECK(plan IN ('starter', 'builder')),
  status TEXT NOT NULL DEFAULT 'inactive',
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0 CHECK(cancel_at_period_end IN (0, 1)),
  current_period_start INTEGER,
  current_period_end INTEGER,
  provider_updated_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX billing_accounts_subscription_idx
  ON billing_accounts(provider, provider_subscription_id);

