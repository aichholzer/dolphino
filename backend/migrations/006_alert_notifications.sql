ALTER TABLE budget_alerts ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;
CREATE TABLE IF NOT EXISTS notification_events (
 id bigserial PRIMARY KEY,
 alert_id uuid NOT NULL REFERENCES budget_alerts(id),
 revision integer NOT NULL,
 mode text NOT NULL CHECK(mode IN ('demo','live')),
 payload jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(alert_id,revision)
);
