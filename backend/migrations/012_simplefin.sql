CREATE TABLE IF NOT EXISTS simplefin_state (
 id integer PRIMARY KEY CHECK(id=1), tested_revision text, tested_at timestamptz,
 last_success timestamptz, last_error text, provider_errors jsonb NOT NULL DEFAULT '[]', next_attempt timestamptz
);
INSERT INTO simplefin_state(id) VALUES(1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS simplefin_claims (
 token_hash text PRIMARY KEY, attempted_at timestamptz NOT NULL DEFAULT now(), outcome text NOT NULL DEFAULT 'ambiguous'
);
CREATE TABLE IF NOT EXISTS simplefin_accounts (
 source_id uuid NOT NULL, remote_key text NOT NULL, identity_key text NOT NULL,
 metadata jsonb NOT NULL, local_id text, mapped_at timestamptz, last_success timestamptz,
 PRIMARY KEY(source_id,remote_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS simplefin_mapped_identity ON simplefin_accounts(identity_key) WHERE local_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS simplefin_mapped_local ON simplefin_accounts(local_id) WHERE local_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS simplefin_jobs (
 id bigserial PRIMARY KEY, dedupe_key text UNIQUE NOT NULL, source_id uuid NOT NULL, remote_key text NOT NULL,
 start_second bigint NOT NULL, end_second bigint NOT NULL CHECK(end_second>start_second),
 status text NOT NULL DEFAULT 'queued', attempts integer NOT NULL DEFAULT 0,
 available_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz, last_error text
);
CREATE TABLE IF NOT EXISTS simplefin_fetches (
 id bigserial PRIMARY KEY, source_id uuid NOT NULL, remote_key text NOT NULL, fetched_at timestamptz NOT NULL DEFAULT now(),
 coverage jsonb NOT NULL, raw jsonb NOT NULL
);
CREATE OR REPLACE FUNCTION reject_simplefin_evidence_changes() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'SimpleFIN evidence is immutable'; END; $$;
DROP TRIGGER IF EXISTS immutable_simplefin_fetches ON simplefin_fetches;
CREATE TRIGGER immutable_simplefin_fetches BEFORE UPDATE OR DELETE ON simplefin_fetches FOR EACH ROW EXECUTE FUNCTION reject_simplefin_evidence_changes();
