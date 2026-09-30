CREATE TABLE IF NOT EXISTS household_users (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 email text NOT NULL UNIQUE CHECK (email=lower(trim(email))),
 name text NOT NULL,
 role text NOT NULL CHECK(role IN ('admin','member')),
 password_hash text NOT NULL,
 disabled boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS household_sessions (
 token_hash text PRIMARY KEY,
 user_id uuid NOT NULL REFERENCES household_users(id) ON DELETE CASCADE,
 expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS household_sessions_user ON household_sessions(user_id);
CREATE TABLE IF NOT EXISTS household_security_audit (
 id bigserial PRIMARY KEY,
 actor_user_id uuid,
 action text NOT NULL,
 target_user_id uuid,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS household_auth_limits (
 key_hash text PRIMARY KEY,
 attempts integer NOT NULL,
 expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS household_auth_state (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 bootstrap_closed boolean NOT NULL DEFAULT false
);
INSERT INTO household_auth_state(singleton,bootstrap_closed) VALUES(true,false) ON CONFLICT DO NOTHING;
UPDATE household_auth_state SET bootstrap_closed=true WHERE EXISTS(SELECT 1 FROM household_users);
CREATE TABLE IF NOT EXISTS household_demo_users (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 email text UNIQUE NOT NULL,
 name text NOT NULL,
 role text NOT NULL CHECK(role IN ('admin','member'))
);
