# Independent MVP review

Reviewed the backend, frontend integration, migrations, deployment configuration and existing tests independently of the initial implementation. This is a scoped code review, not a penetration test or a claim of production assurance.

## Findings addressed during follow-up

- Fresh polls reintroduced classification warnings after a manual correction or explicit review decision. Unchanged evidence now preserves that decision; changed financial evidence can reopen review. Rules clear classification warnings they resolve, while source identity warnings remain separate. A PostgreSQL regression covers these repeated flows.
- PostgreSQL DATE values were converted through UTC, shifting dates on hosts east of UTC. Calendar dates now retain their local date fields; a separate process using `TZ=Australia/Brisbane` verifies that 1 September remains 1 September.
- Overspend alerts were initially response-only calculations, with no durable identity. Follow-up adds persisted, deduplicated alert state (see alert integration tests).
- Optional LLM suggestions were initially synchronous API calls. Follow-up adds an explicitly requested durable suggestion job, configurable through server secrets and disabled until configured. Rules remain synchronous and first in the classification order; LLM suggestions require manual acceptance.

- The follow-up suggestion worker originally acquired a second pooled connection while holding a worker lock, risking pool exhaustion under concurrent requests. Reads now reuse the held client; tests run with a single-connection pool. A one-way credential digest also allows corrected provider credentials to retry an exhausted job without storing secrets.

## Confirmed architecture

`server.js` starts the ingestion timer. It checks every 15 seconds and inserts unique four-hour poll buckets. PostgreSQL advisory locking serializes workers; durable queued jobs and receipts support restart and replay. The selected thin webhook contract queues the same REST discovery/import routine as polling, so both paths use the same source aliases and canonical ledger. Full transaction webhooks are deliberately unsupported.

Financial reports use integer minor units and explicit currency, with one backend calculation engine for reports, budget spending and export summaries. Raw evidence and manual overrides are separate. Pending records remain outside posted actuals and ambiguous replacements require review. Balance snapshots remain explicitly unreconciled. Live authentication gates financial routes independently of Redbark connection status. Secrets are server configuration only; errors do not return raw provider responses or credentials. No real financial calls were used in this review.

## Remaining limits and operational caveats

- The scheduler runs only while the app process is running. It resumes polling on restart; it cannot make bank data instantly fresh. Provider access/version support still needs the owner's successful connection test.
- The LLM flow is opt-in per transaction, not automatic batch classification of all imports. Rules and provider categories continue working without it.
- Generic provider transfer categories are provisional: the user must confirm internal transfers/card repayments versus external transfers in review. Income/refund classification can likewise require correction.
- There is no compatible opening balance or complete historical coverage proof, so no balance reconciliation is claimed. Default imports use an explicit bounded lookback; older corrections require increasing the configured window.
- Single-user session cookies expire after 12 hours. Logout clears the browser cookie; there is no server-side revocation list. Keep HTTPS and a protected home-lab reverse proxy; changing the session secret invalidates all sessions.
- Login throttling is in memory and resets on restart; a reverse proxy should provide persistent rate limiting for any Internet-facing deployment. No Internet deployment was performed.
- In-app alerts only; external notifications, multi-user access and FX conversion are unsupported.

Compose parsing, PostgreSQL tests, backup/restore rehearsal, screenshot artifacts and final commands are recorded in `verification.md`.
