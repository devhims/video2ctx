-- Existing personal API keys gain access to routine user-owned account operations.
-- Sensitive account controls remain protected by session-only route middleware.
UPDATE apikey
SET permissions = '{"data":["read"],"account":["access"]}',
    updatedAt = CAST(unixepoch('subsec') * 1000 AS INTEGER)
WHERE configId = 'default';
