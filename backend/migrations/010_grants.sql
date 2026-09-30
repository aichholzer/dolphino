CREATE TABLE IF NOT EXISTS user_account_grants (
 user_id text NOT NULL,
 mode text NOT NULL CHECK(mode IN ('live','demo')),
 account_id text NOT NULL,
 permission text NOT NULL CHECK(permission IN ('view','edit')),
 PRIMARY KEY(user_id,mode,account_id),
 FOREIGN KEY(mode,account_id) REFERENCES accounts(mode,id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS user_budget_grants (
 user_id text NOT NULL,
 mode text NOT NULL CHECK(mode IN ('live','demo')),
 budget_id uuid NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
 permission text NOT NULL CHECK(permission IN ('view','edit')),
 PRIMARY KEY(user_id,mode,budget_id)
);
