# Import health and bounded backfill

**Settings → Data** shows import status, account freshness, the last recorded fetch coverage window, canonical transaction counts, and the latest 30 durable jobs. Coverage describes the latest successful fetch, not a claim of complete account history or balance reconciliation. A backfill's older window can become the latest coverage window; regular reconciliation returns to its configured recent window on the next poll. All accounts continue syncing.

After a successful live Redbark connection test and initial account discovery, select an imported account and explicit start/end dates for a historical import. The interval must be valid, ordered, no more than 2555 days, and cannot end in the future. The backend discovers accounts again and fetches only that account over the selected dates using the existing pagination and truncated-window splitting logic. No event-provided arbitrary URL is fetched. These are queued imports, not guaranteed instant fresh bank activity.

Each account/date-range combination has one durable job identity. Repeated clicks, process restarts, and concurrent submissions return the same job, including its completed state. Choose the intended bounded range once; failed jobs retry automatically. The manual retry control reaffirms the existing failed job without creating another import or bypassing provider `Retry-After` and exponential backoff. It reports the next eligible attempt; the normal worker must be running. Re-test the connection if configuration is changed or verification fails. Already imported data remains accessible during provider downtime.

Authenticated, same-origin APIs:

- `GET /api/import-health`
- `POST /api/import-health/backfill` with `{ "accountId": "acct_…", "from": "2026-01-01", "to": "2026-01-31" }`
- `POST /api/import-health/retry` with `{ "jobId": "123" }`

Existing immutable provider observations and canonical identity matching apply to historical imports exactly as they do to polling and webhook-triggered imports. No balancing entries are invented. Ambiguous pending replacements remain in review.

Verification: `node --test backend/test/import-health.test.mjs` with `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD` and explicit `PGSSLMODE` pointing only to an isolated test database. Tests use fictional mocked Redbark responses, isolated PostgreSQL schemas, concurrent duplicate submissions, restarted service facades, explicit dates/account scope, and a simulated 429 response. No provider calls are made.

Manual accounts have no feed. Frozen and soft-deleted feed accounts continue importing while the provider supplies data. Missing upstream accounts never delete local history. Permanently deleted local account identities are excluded from future imports; see [account lifecycle](manual-accounts.md).
