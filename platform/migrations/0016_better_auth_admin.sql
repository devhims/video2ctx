-- Better Auth admin plugin fields. Existing Agent grants are unchanged.
ALTER TABLE user ADD COLUMN role TEXT NOT NULL DEFAULT 'user';
ALTER TABLE user ADD COLUMN banned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE user ADD COLUMN banReason TEXT;
ALTER TABLE user ADD COLUMN banExpires INTEGER;
ALTER TABLE session ADD COLUMN impersonatedBy TEXT;
