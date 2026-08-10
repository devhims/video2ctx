-- Better Auth API key plugin schema for @better-auth/api-key 1.6.26.
-- Keys are hashed by the plugin; only their prefix/start is stored for display.
CREATE TABLE apikey (
  id TEXT PRIMARY KEY,
  configId TEXT NOT NULL DEFAULT 'default',
  name TEXT,
  start TEXT,
  referenceId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  prefix TEXT,
  key TEXT NOT NULL,
  refillInterval INTEGER,
  refillAmount INTEGER,
  lastRefillAt INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  rateLimitEnabled INTEGER NOT NULL DEFAULT 1,
  rateLimitTimeWindow INTEGER DEFAULT 60000,
  rateLimitMax INTEGER DEFAULT 60,
  requestCount INTEGER NOT NULL DEFAULT 0,
  remaining INTEGER,
  lastRequest INTEGER,
  expiresAt INTEGER,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  permissions TEXT,
  metadata TEXT
);

CREATE INDEX apikey_config_idx ON apikey(configId);
CREATE INDEX apikey_reference_idx ON apikey(referenceId);
CREATE INDEX apikey_key_idx ON apikey(key);
