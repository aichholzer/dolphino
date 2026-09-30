ALTER TABLE notification_events ADD COLUMN IF NOT EXISTS scanned_at timestamptz;
CREATE TABLE IF NOT EXISTS notification_outbox (
 id bigserial PRIMARY KEY,
 event_id bigint NOT NULL REFERENCES notification_events(id),
 channel text NOT NULL CHECK(channel IN ('smtp','telegram')),
 recipient text NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sent','failed','cancelled')),
 attempts integer NOT NULL DEFAULT 0,
 next_attempt_at timestamptz NOT NULL DEFAULT now(),
 error text,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(event_id,channel,recipient)
);
