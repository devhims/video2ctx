CREATE TABLE deviceCode (
  id TEXT PRIMARY KEY,
  deviceCode TEXT NOT NULL UNIQUE,
  userCode TEXT NOT NULL UNIQUE,
  userId TEXT REFERENCES user(id) ON DELETE CASCADE,
  expiresAt INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'denied')),
  lastPolledAt INTEGER,
  pollingInterval INTEGER,
  clientId TEXT,
  scope TEXT
);

CREATE INDEX device_code_user_idx ON deviceCode(userId);
CREATE INDEX device_code_expiry_idx ON deviceCode(expiresAt);
