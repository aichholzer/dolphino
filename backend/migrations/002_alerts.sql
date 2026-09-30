-- Durable current alert state reconciled within each serialized financial mutation.
CREATE TABLE IF NOT EXISTS budget_alerts (
 id uuid PRIMARY KEY,
 mode text NOT NULL CHECK(mode IN ('demo','live')),
 currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
 month text NOT NULL CHECK(month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
 category text NOT NULL, type text NOT NULL CHECK(type='overspend'),
 amount_minor bigint NOT NULL CHECK(amount_minor > 0), message text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 resolved_at timestamptz,
 UNIQUE(mode,currency,month,category,type)
);
