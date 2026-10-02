ALTER TABLE rules ADD COLUMN IF NOT EXISTS tags jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Explicit user choices outlive rules and polling. Effective tags remain in
-- transaction_tags so every existing scoped read/filter/export uses one set.
CREATE TABLE IF NOT EXISTS transaction_tag_preferences (
 transaction_id uuid NOT NULL REFERENCES transactions(id),
 tag text NOT NULL CHECK(length(tag) BETWEEN 1 AND 40 AND tag=lower(btrim(tag))),
 removed boolean NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(transaction_id,tag)
);
-- All tags predating rule tagging were manual. Repeated migrations must not
-- promote subsequently automatic tags, hence this one-time migration marker.
CREATE TABLE IF NOT EXISTS data_migrations (name text PRIMARY KEY);
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM data_migrations WHERE name='015_manual_tag_preferences') THEN
  INSERT INTO transaction_tag_preferences(transaction_id,tag,removed,updated_at)
   SELECT transaction_id,tag,false,'epoch'::timestamptz FROM transaction_tags ON CONFLICT DO NOTHING;
  INSERT INTO data_migrations(name) VALUES('015_manual_tag_preferences') ON CONFLICT DO NOTHING;
 END IF;
END $$;
