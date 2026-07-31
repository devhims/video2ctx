PRAGMA foreign_keys = ON;

-- Better Auth core schema. Keep column names synchronized with the auth config.
CREATE TABLE user (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  emailVerified INTEGER NOT NULL DEFAULT 0,
  image TEXT,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);
CREATE TABLE session (
  id TEXT PRIMARY KEY,
  expiresAt INTEGER NOT NULL,
  token TEXT NOT NULL UNIQUE,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  ipAddress TEXT,
  userAgent TEXT,
  userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE
);
CREATE INDEX session_user_idx ON session(userId);
CREATE TABLE account (
  id TEXT PRIMARY KEY,
  accountId TEXT NOT NULL,
  providerId TEXT NOT NULL,
  userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  accessToken TEXT,
  refreshToken TEXT,
  idToken TEXT,
  accessTokenExpiresAt INTEGER,
  refreshTokenExpiresAt INTEGER,
  scope TEXT,
  password TEXT,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);
CREATE INDEX account_user_idx ON account(userId);
CREATE TABLE verification (
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  expiresAt INTEGER NOT NULL,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);
CREATE INDEX verification_identifier_idx ON verification(identifier);

CREATE TABLE plans (
  user_id TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
  plan TEXT NOT NULL DEFAULT 'free' CHECK(plan IN ('free', 'pro')),
  stripe_customer_id TEXT UNIQUE,
  stripe_subscription_id TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'active',
  period_end INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  tags_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX projects_owner_idx ON projects(user_id, updated_at DESC);
CREATE TABLE project_items (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  start_ms INTEGER,
  end_ms INTEGER,
  note TEXT NOT NULL DEFAULT '',
  tags_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  UNIQUE(project_id, entity_type, entity_id, start_ms)
);
CREATE INDEX project_items_search_idx ON project_items(user_id, project_id, entity_type, entity_id);
CREATE TABLE entity_snapshots (
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  data_json TEXT NOT NULL,
  provenance_json TEXT NOT NULL,
  r2_key TEXT,
  fetched_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY(entity_type, entity_id)
);
CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  owner_scope TEXT NOT NULL CHECK(owner_scope IN ('public', 'private')),
  user_id TEXT,
  project_id TEXT,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  language TEXT,
  title TEXT NOT NULL,
  body_preview TEXT NOT NULL DEFAULT '',
  r2_key TEXT NOT NULL,
  indexed_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX documents_private_idx ON documents(user_id, project_id, entity_id);
CREATE INDEX documents_public_idx ON documents(owner_scope, entity_type, entity_id);
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  input_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','running','partial','succeeded','failed','cancelled')),
  progress INTEGER NOT NULL DEFAULT 0 CHECK(progress BETWEEN 0 AND 100),
  attempts INTEGER NOT NULL DEFAULT 0,
  partial_result_json TEXT,
  retry_at INTEGER,
  failure_code TEXT,
  failure_reason TEXT,
  idempotency_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(user_id, idempotency_key)
);
CREATE INDEX jobs_owner_idx ON jobs(user_id, created_at DESC);
CREATE TABLE monitors (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('channel','topic','search')),
  target TEXT NOT NULL,
  query_json TEXT NOT NULL DEFAULT '{}',
  cadence TEXT NOT NULL DEFAULT 'hourly',
  enabled INTEGER NOT NULL DEFAULT 1,
  last_checked_at INTEGER,
  last_cursor TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(user_id, kind, target)
);
CREATE TABLE analytics_snapshots (
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  captured_at INTEGER NOT NULL,
  view_count INTEGER,
  like_count INTEGER,
  comment_count INTEGER,
  velocity REAL,
  PRIMARY KEY(entity_type, entity_id, captured_at)
);
CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  data_json TEXT NOT NULL DEFAULT '{}',
  read_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX notifications_owner_idx ON notifications(user_id, created_at DESC);
CREATE TABLE notification_preferences (
  user_id TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
  in_app INTEGER NOT NULL DEFAULT 1,
  email_digest TEXT NOT NULL DEFAULT 'weekly' CHECK(email_digest IN ('off','daily','weekly')),
  unsubscribed_at INTEGER,
  unsubscribe_token_hash TEXT,
  updated_at INTEGER NOT NULL
);
CREATE TABLE credit_ledger (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL,
  entry_type TEXT NOT NULL CHECK(entry_type IN ('grant','reserve','settle','release','adjustment')),
  credits INTEGER NOT NULL,
  provider_cost_micros INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  UNIQUE(user_id, operation_id, entry_type)
);
CREATE INDEX credit_ledger_owner_idx ON credit_ledger(user_id, created_at DESC);
CREATE TABLE processed_events (
  source TEXT NOT NULL,
  event_id TEXT NOT NULL,
  processed_at INTEGER NOT NULL,
  payload_hash TEXT NOT NULL,
  PRIMARY KEY(source, event_id)
);
CREATE TABLE oauth_connections (
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  encrypted_refresh_token TEXT NOT NULL,
  scopes TEXT NOT NULL,
  channel_id TEXT,
  expires_at INTEGER,
  connected_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(user_id, provider)
);
CREATE TABLE oauth_states (
  state_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  code_verifier TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE email_deliveries (
  idempotency_key TEXT PRIMARY KEY,
  user_id TEXT,
  recipient_hash TEXT NOT NULL,
  template TEXT NOT NULL,
  status TEXT NOT NULL,
  provider_message_id TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at INTEGER NOT NULL
);
CREATE TABLE exports (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  project_id TEXT,
  format TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER
);
