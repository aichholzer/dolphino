CREATE TABLE IF NOT EXISTS assistant_usage (
 user_id text NOT NULL,
 usage_day date NOT NULL,
 requests integer NOT NULL CHECK(requests>=0),
 PRIMARY KEY(user_id,usage_day)
);
