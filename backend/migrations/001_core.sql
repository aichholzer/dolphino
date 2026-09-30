CREATE TABLE IF NOT EXISTS accounts (
 id text NOT NULL, mode text NOT NULL CHECK(mode IN ('demo','live')), name text NOT NULL, currency text NOT NULL,
 balance_minor bigint, balance_type text, balance_at timestamptz, fetched_at timestamptz NOT NULL DEFAULT now(), coverage jsonb,
 PRIMARY KEY(mode,id)
);
CREATE TABLE IF NOT EXISTS transactions (
 id uuid PRIMARY KEY, mode text NOT NULL CHECK(mode IN ('demo','live')), account_id text NOT NULL,
 currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'), amount_minor bigint NOT NULL, status text NOT NULL CHECK(status IN ('pending','posted')),
 date date NOT NULL, description text NOT NULL, provider_category text, classification_category text,
 kind text NOT NULL CHECK(kind IN ('expense','income','transfer','refund')), fetched_at timestamptz NOT NULL,
 review_reason text, superseded_by uuid REFERENCES transactions(id), created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(mode,account_id) REFERENCES accounts(mode,id)
);
CREATE TABLE IF NOT EXISTS source_aliases (
 mode text NOT NULL, provider text NOT NULL, account_id text NOT NULL, source_id text NOT NULL,
 transaction_id uuid NOT NULL REFERENCES transactions(id), PRIMARY KEY(mode,provider,account_id,source_id)
);
CREATE TABLE IF NOT EXISTS provider_observations (
 id bigserial PRIMARY KEY, mode text NOT NULL, provider text NOT NULL, account_id text NOT NULL, source_id text NOT NULL,
 transaction_id uuid NOT NULL REFERENCES transactions(id), fetched_at timestamptz NOT NULL, payload jsonb NOT NULL,
 fingerprint text NOT NULL, UNIQUE(mode,provider,account_id,source_id,fingerprint)
);
CREATE OR REPLACE FUNCTION reject_observation_changes() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Provider observations are immutable'; END; $$;
DROP TRIGGER IF EXISTS immutable_observations ON provider_observations;
CREATE TRIGGER immutable_observations BEFORE UPDATE OR DELETE ON provider_observations FOR EACH ROW EXECUTE FUNCTION reject_observation_changes();
CREATE TABLE IF NOT EXISTS transaction_overrides (
 transaction_id uuid PRIMARY KEY REFERENCES transactions(id), category text, kind text CHECK(kind IN ('expense','income','transfer','refund')),
 splits jsonb, note text, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS audit_history (
 id bigserial PRIMARY KEY, mode text NOT NULL, transaction_id uuid REFERENCES transactions(id), action text NOT NULL,
 before_value jsonb, after_value jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS budgets (
 id uuid PRIMARY KEY, mode text NOT NULL, category text NOT NULL, currency text NOT NULL, month text NOT NULL CHECK(month ~ '^\d{4}-\d{2}$'),
 cap_minor bigint NOT NULL CHECK(cap_minor >= 0), allocation_minor bigint NOT NULL DEFAULT 0 CHECK(allocation_minor >= 0),
 rollover boolean NOT NULL DEFAULT false, UNIQUE(mode,category,currency,month)
);
CREATE TABLE IF NOT EXISTS rules (
 id uuid PRIMARY KEY, mode text NOT NULL, contains text NOT NULL CHECK(length(contains)>0), category text NOT NULL,
 kind text CHECK(kind IN ('expense','income','transfer','refund')), priority integer NOT NULL DEFAULT 0,
 UNIQUE(mode,contains)
);
CREATE INDEX IF NOT EXISTS transactions_month ON transactions(mode,date,currency);
CREATE INDEX IF NOT EXISTS aliases_transaction ON source_aliases(transaction_id);
