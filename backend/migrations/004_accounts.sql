ALTER TABLE accounts ADD COLUMN IF NOT EXISTS local_label text;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '';
-- Remove the unpublished account-disable experiment if this migration was run during development.
ALTER TABLE accounts DROP COLUMN IF EXISTS enabled;
