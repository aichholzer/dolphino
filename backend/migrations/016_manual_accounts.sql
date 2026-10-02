-- Existing identities and evidence stay in place. Origin is permanent.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS source_type text NOT NULL DEFAULT 'feed' CHECK(source_type IN ('feed','manual'));
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS frozen_at timestamptz;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS account_revision integer NOT NULL DEFAULT 0 CHECK(account_revision >= 0);
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
CREATE TABLE IF NOT EXISTS manual_entries (
 id uuid PRIMARY KEY, mode text NOT NULL CHECK(mode IN ('demo','live')),
 entry_type text NOT NULL CHECK(entry_type IN ('opening','activity','transfer','adjustment')),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0), voided_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(mode,id)
);
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS opening_entry_id uuid;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='accounts'::regclass AND conname='accounts_opening_entry_fk') THEN
  ALTER TABLE accounts ADD CONSTRAINT accounts_opening_entry_fk FOREIGN KEY(mode,opening_entry_id) REFERENCES manual_entries(mode,id);
  ALTER TABLE accounts ADD CONSTRAINT accounts_manual_origin CHECK((source_type='manual')=(opening_entry_id IS NOT NULL));
 END IF;
END $$;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS manual_entry_id uuid;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS voided_at timestamptz;
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_kind_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_kind_check CHECK(kind IN ('expense','income','transfer','refund','opening','adjustment'));
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='transactions'::regclass AND conname='transactions_manual_entry_fk') THEN
  ALTER TABLE transactions ADD CONSTRAINT transactions_manual_entry_fk FOREIGN KEY(mode,manual_entry_id) REFERENCES manual_entries(mode,id);
  ALTER TABLE transactions ADD CONSTRAINT transactions_manual_only_kinds CHECK(manual_entry_id IS NOT NULL OR (kind NOT IN ('opening','adjustment') AND voided_at IS NULL));
 END IF;
END $$;
CREATE INDEX IF NOT EXISTS transactions_manual_entry ON transactions(mode,manual_entry_id) WHERE manual_entry_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS manual_events (
 id bigserial PRIMARY KEY, mode text NOT NULL, entry_id uuid, account_id text,
 actor_id text NOT NULL, actor_name text NOT NULL, action text NOT NULL,
 before_value jsonb, after_value jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(mode,entry_id) REFERENCES manual_entries(mode,id), FOREIGN KEY(mode,account_id) REFERENCES accounts(mode,id)
);
CREATE INDEX IF NOT EXISTS manual_events_entry ON manual_events(mode,entry_id,id);
CREATE TABLE IF NOT EXISTS manual_commands (
 mode text NOT NULL, actor_id text NOT NULL, request_id uuid NOT NULL,
 fingerprint text NOT NULL, response jsonb NOT NULL, account_ids text[] NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(mode,actor_id,request_id)
);
CREATE OR REPLACE FUNCTION manual_account_origin_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.source_type<>OLD.source_type OR NEW.opening_entry_id IS DISTINCT FROM OLD.opening_entry_id OR (OLD.source_type='manual' AND NEW.currency<>OLD.currency) THEN
  RAISE EXCEPTION 'Account origin and opening identity are permanent' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS manual_account_origin ON accounts;
CREATE TRIGGER manual_account_origin BEFORE UPDATE ON accounts FOR EACH ROW EXECUTE FUNCTION manual_account_origin_guard();
CREATE OR REPLACE FUNCTION manual_transaction_origin_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE origin text;
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.manual_entry_id IS NOT NULL AND NOT account_purge_allowed(OLD.mode,OLD.account_id) THEN RAISE EXCEPTION 'Manual entries must be voided, never deleted' USING ERRCODE='23514'; END IF;
  RETURN OLD;
 END IF;
 SELECT source_type INTO origin FROM accounts WHERE mode=NEW.mode AND id=NEW.account_id;
 IF (origin='manual') IS DISTINCT FROM (NEW.manual_entry_id IS NOT NULL) THEN
  RAISE EXCEPTION 'Financial entry origin must match its account' USING ERRCODE='23514';
 END IF;
 IF NEW.manual_entry_id IS NOT NULL AND (NEW.status<>'posted' OR NEW.superseded_by IS NOT NULL) THEN
  RAISE EXCEPTION 'Manual entries cannot be pending or import replacements' USING ERRCODE='23514';
 END IF;
 IF TG_OP='UPDATE' AND (OLD.manual_entry_id IS NOT NULL OR NEW.manual_entry_id IS NOT NULL) AND
  (NEW.manual_entry_id IS DISTINCT FROM OLD.manual_entry_id OR NEW.account_id<>OLD.account_id OR NEW.mode<>OLD.mode OR NEW.id<>OLD.id OR NEW.currency<>OLD.currency) THEN
  RAISE EXCEPTION 'Manual entry identity, account and currency are permanent' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS manual_transaction_origin ON transactions;
CREATE TRIGGER manual_transaction_origin BEFORE INSERT OR UPDATE OR DELETE ON transactions FOR EACH ROW EXECUTE FUNCTION manual_transaction_origin_guard();
CREATE OR REPLACE FUNCTION manual_import_evidence_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM transactions WHERE id=NEW.transaction_id AND manual_entry_id IS NOT NULL) THEN
  RAISE EXCEPTION 'Manual entries cannot receive import evidence or identities' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS no_manual_observations ON provider_observations;
CREATE TRIGGER no_manual_observations BEFORE INSERT ON provider_observations FOR EACH ROW EXECUTE FUNCTION manual_import_evidence_guard();
DROP TRIGGER IF EXISTS no_manual_aliases ON source_aliases;
CREATE TRIGGER no_manual_aliases BEFORE INSERT OR UPDATE ON source_aliases FOR EACH ROW EXECUTE FUNCTION manual_import_evidence_guard();
CREATE OR REPLACE FUNCTION manual_event_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' AND current_setting('dolphino.purge_mode',true)=OLD.mode AND (account_purge_allowed(OLD.mode,OLD.account_id) OR (OLD.entry_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM transactions WHERE mode=OLD.mode AND manual_entry_id=OLD.entry_id AND NOT account_purge_allowed(mode,account_id)))) THEN RETURN OLD; END IF;
 RAISE EXCEPTION 'Manual ledger audit history is immutable';
END $$;
DROP TRIGGER IF EXISTS immutable_manual_events ON manual_events;
CREATE TRIGGER immutable_manual_events BEFORE UPDATE OR DELETE ON manual_events FOR EACH ROW EXECUTE FUNCTION manual_event_immutable();

-- The application sets this narrow transaction-local scope only after an administrator
-- confirms a fresh deletion preview. Updates to evidence are never permitted.
CREATE OR REPLACE FUNCTION account_purge_allowed(m text,a text) RETURNS boolean LANGUAGE sql AS $$
 SELECT COALESCE(current_setting('dolphino.purge_mode',true)=m AND a=ANY(string_to_array(current_setting('dolphino.purge_accounts',true),',')),false)
$$;
CREATE TABLE IF NOT EXISTS account_tombstones (
 mode text NOT NULL, account_id text NOT NULL, source_type text NOT NULL, deleted_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(mode,account_id)
);
CREATE TABLE IF NOT EXISTS account_lifecycle_events (
 id bigserial PRIMARY KEY, mode text NOT NULL, account_id text NOT NULL, actor_id text NOT NULL,
 action text NOT NULL, details jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION lifecycle_event_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 RAISE EXCEPTION 'Account lifecycle audit history is immutable';
END $$;
DROP TRIGGER IF EXISTS immutable_lifecycle_events ON account_lifecycle_events;
CREATE TRIGGER immutable_lifecycle_events BEFORE UPDATE OR DELETE ON account_lifecycle_events FOR EACH ROW EXECUTE FUNCTION lifecycle_event_immutable();
CREATE OR REPLACE FUNCTION reject_observation_changes() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' AND account_purge_allowed(OLD.mode,OLD.account_id) THEN RETURN OLD; END IF;
 RAISE EXCEPTION 'Provider observations are immutable';
END $$;
CREATE OR REPLACE FUNCTION reject_simplefin_evidence_changes() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' AND EXISTS(SELECT 1 FROM simplefin_accounts WHERE source_id=OLD.source_id AND remote_key=OLD.remote_key AND account_purge_allowed('live',local_id)) THEN RETURN OLD; END IF;
 RAISE EXCEPTION 'SimpleFIN evidence is immutable';
END $$;
CREATE OR REPLACE FUNCTION account_tombstone_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM account_tombstones WHERE mode=NEW.mode AND account_id=NEW.id) THEN RAISE EXCEPTION 'Permanently deleted account cannot be recreated'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS no_resurrected_accounts ON accounts;
CREATE TRIGGER no_resurrected_accounts BEFORE INSERT ON accounts FOR EACH ROW EXECUTE FUNCTION account_tombstone_guard();

CREATE INDEX IF NOT EXISTS manual_account_balance ON transactions(mode,account_id,date) WHERE manual_entry_id IS NOT NULL AND voided_at IS NULL;
