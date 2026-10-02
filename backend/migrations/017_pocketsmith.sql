CREATE TABLE IF NOT EXISTS pocketsmith_accounts (
 local_id text PRIMARY KEY, user_id text NOT NULL, native_id text NOT NULL,
 metadata jsonb NOT NULL, enabled boolean NOT NULL DEFAULT false,
 cursor timestamptz, last_success timestamptz, last_error text,
 next_attempt timestamptz NOT NULL DEFAULT now(), attempts integer NOT NULL DEFAULT 0,
 history_from date, backfill_next date, backfill_to date,
 UNIQUE(user_id,native_id)
);
CREATE TABLE IF NOT EXISTS pocketsmith_state (
 id integer PRIMARY KEY CHECK(id=1), tested_revision text, tested_at timestamptz, last_error text
);
INSERT INTO pocketsmith_state(id) VALUES(1) ON CONFLICT DO NOTHING;
ALTER TABLE pocketsmith_state ADD COLUMN IF NOT EXISTS next_attempt timestamptz;
CREATE TABLE IF NOT EXISTS pocketsmith_fetches (
 id bigserial PRIMARY KEY, account_id text NOT NULL, fetched_at timestamptz NOT NULL,
 query jsonb NOT NULL, account_evidence jsonb NOT NULL, pages jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS pocketsmith_fetches_account ON pocketsmith_fetches(account_id,id);
CREATE TABLE IF NOT EXISTS pocketsmith_versions (
 account_id text NOT NULL, source_id text NOT NULL, updated_at timestamptz NOT NULL,
 fingerprint text NOT NULL, PRIMARY KEY(account_id,source_id)
);
CREATE TABLE IF NOT EXISTS pocketsmith_categories (
 user_id text NOT NULL, native_id text NOT NULL, category text NOT NULL UNIQUE,
 provider_name text NOT NULL, PRIMARY KEY(user_id,native_id)
);
CREATE OR REPLACE FUNCTION reject_pocketsmith_evidence_changes() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' AND account_purge_allowed('live',OLD.account_id) THEN RETURN OLD; END IF;
 RAISE EXCEPTION 'PocketSmith evidence is immutable';
END $$;
DROP TRIGGER IF EXISTS immutable_pocketsmith_fetches ON pocketsmith_fetches;
CREATE TRIGGER immutable_pocketsmith_fetches BEFORE UPDATE OR DELETE ON pocketsmith_fetches FOR EACH ROW EXECUTE FUNCTION reject_pocketsmith_evidence_changes();
