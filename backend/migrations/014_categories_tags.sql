-- Category keys remain unchanged in the ledger, overrides, rules and budgets.
-- Names and archive state are presentation metadata, never rewritten import evidence.
CREATE TABLE IF NOT EXISTS category_catalog (
 mode text NOT NULL CHECK(mode IN ('demo','live')),
 category text NOT NULL CHECK(length(category) BETWEEN 1 AND 100),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
 archived boolean NOT NULL DEFAULT false,
 shared boolean NOT NULL DEFAULT false,
 PRIMARY KEY(mode,category)
);
INSERT INTO category_catalog(mode,category,name,shared)
 SELECT mode,name,name,true FROM unnest(ARRAY['demo','live']) mode
 CROSS JOIN unnest(ARRAY['Uncategorized','Groceries','Dining','Transport','Shopping','Housing','Utilities','Health','Entertainment','Income','Other','Travel']) name
 ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS transaction_tags (
 transaction_id uuid NOT NULL REFERENCES transactions(id),
 tag text NOT NULL CHECK(length(tag) BETWEEN 1 AND 40 AND tag=lower(btrim(tag))),
 PRIMARY KEY(transaction_id,tag)
);
CREATE INDEX IF NOT EXISTS tags_lookup ON transaction_tags(tag,transaction_id);
CREATE INDEX IF NOT EXISTS transactions_scoped_history ON transactions(mode,account_id,currency,date DESC,id)
 WHERE superseded_by IS NULL;
-- pg_trgm is a trusted PostgreSQL extension; the migration role needs CREATE on its database.
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
DO $$ DECLARE extension_schema text;
BEGIN
 SELECT n.nspname INTO extension_schema FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='pg_trgm';
 EXECUTE format('CREATE INDEX IF NOT EXISTS transactions_description_search ON transactions USING gin(description %I.gin_trgm_ops)',extension_schema);
 EXECUTE format('CREATE INDEX IF NOT EXISTS overrides_note_search ON transaction_overrides USING gin(note %I.gin_trgm_ops)',extension_schema);
END $$;
