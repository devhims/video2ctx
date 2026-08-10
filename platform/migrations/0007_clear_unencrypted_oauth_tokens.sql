-- Better Auth now encrypts provider tokens before database storage.
-- Existing plaintext tokens cannot be encrypted in SQL without the runtime secret,
-- so remove them and let the provider issue fresh encrypted values on next sign-in.
UPDATE account
SET accessToken = NULL,
    refreshToken = NULL,
    idToken = NULL
WHERE accessToken IS NOT NULL
   OR refreshToken IS NOT NULL
   OR idToken IS NOT NULL;
