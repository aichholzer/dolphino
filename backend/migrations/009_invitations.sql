CREATE TABLE IF NOT EXISTS household_invitations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 email text NOT NULL,
 role text NOT NULL CHECK(role IN ('admin','member')),
 purpose text NOT NULL CHECK(purpose IN ('invite','reset')),
 user_id uuid REFERENCES household_users(id) ON DELETE CASCADE,
 token_hash text NOT NULL UNIQUE,
 expires_at timestamptz NOT NULL,
 used_at timestamptz,
 revoked_at timestamptz,
 delivery_state text NOT NULL DEFAULT 'sending' CHECK(delivery_state IN ('sending','sent','failed','operator')),
 last_error text,
 created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE household_invitations ADD COLUMN IF NOT EXISTS grants jsonb NOT NULL DEFAULT '{"accounts":[],"budgets":[]}';
