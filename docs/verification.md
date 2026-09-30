# MVP verification — 30 September 2026

All records used during development and verification are fictional. No production credentials or financial services were used. Tests create temporary PostgreSQL schemas and remove them afterward. Use a disposable database with schema creation permissions.

## Commands and outcomes

- `DATABASE_URL=postgresql://profe@127.0.0.1:54329/profe_test npm test`: passed all 67 tests, including real PostgreSQL integration. No database tests skipped in the final run.
- `npm run build`: production Vite build passed.
- `npm run lint`: backend/script JavaScript syntax checks passed.
- `node scripts/browser-check.mjs`: Chromium desktop (1440px) and mobile (390px) checks passed. Checked income/spending, refund drilldown, excluded repayment, two genuine identical coffees, invalid split rejection, cancelled edit, budget save, account freshness, disabled demo connection test, JSON export, and API failure/retry recovery. No uncaught browser errors or viewport overflow.
- `npm audit --omit=dev --audit-level=high`: zero known production dependency vulnerabilities at verification time.
- Both external-database and bundled-database Compose configurations parsed with `docker compose config --format json`; assertions confirmed the default has only the external URL, the override selects `db` and clears `DATABASE_URL_FILE`, and bundled PostgreSQL publishes no port.
- Actual isolated backup/restore rehearsal passed using the repository shell scripts and PostgreSQL 18 client tools built under `/tmp`: all rows across 20 public tables and complete financial reports matched. Both new fictional databases and the dump were deleted. See [restore evidence](restore-evidence.md).

PostgreSQL 18.4 ran locally from temporary extracted binaries after Docker Hub denied the image pull. Docker itself is available, but a complete container image build could not be verified because base-image downloads were blocked.

## Correctness covered

Currency precision for AUD/JPY/KWD, integer arithmetic above JavaScript's safe-number range; exact signed splits; refund month policy; uncategorized spending; transfer exclusion; allocation and positive/negative rollover policy; two identical genuine purchases; unique replay/concurrent import; older observation ordering; pending-to-posted aliases and ambiguous review; immutable evidence; independent overrides and audit; invalidated splits after source amount changes; atomic batch rollback; and strict demo/live separation.

Signed raw-byte webhook verification, five-minute replay window, rotated signatures, durable receipt deduplication/conflict rollback, restart, serialized workers, credentials/version test gating, mocked account/transaction import, pagination, truncated-window splitting, and durable Retry-After are tested without contacting Redbark. A separate live-mode REST test proves provider failure does not block imported data, corrections, budgets or exports.

## Review artifacts

`artifacts/profe-desktop.png`, `artifacts/profe-mobile.png`, and `artifacts/profe-budgets.png` show the fictional demo. They are also saved to the conversation's Library for visual review. The local preview runs at `http://localhost:3001`; it is not a public deployment.

## Deliberate MVP limits

- Real Redbark beta/version access remains unverified until the owner tests their server-side configuration.
- Only v2 thin-event destinations are supported, not full transaction webhook destinations.
- Provider categories are provisional evidence. Ambiguous refunds, repayments and identity replacements require review; no guessed balancing entries are created.
- Balance reconciliation remains explicitly incomplete without compatible opening balance/time/type/coverage.
- New accounts are discovered during polling; owners maintain Redbark sync coverage. Bank freshness is provider-dependent.
- Positive rollover requires consecutive configured budget months. Budgets can be saved or updated via the UI; recurring budget templates and automatic month creation are future work.
- JSON export is an analysis snapshot, not a complete backup. PostgreSQL backup/restore is required for full evidence, jobs and audit history.
- Optional Telegram and SMTP delivery are implemented and mocked in tests; actual destinations remain owner-configured. Multi-user access, foreign-exchange conversion and broader provider adapters remain future work.

## Follow-up review and verification

An [independent review](review.md) found and corrected repeated review warnings and non-UTC calendar-date conversion. Final follow-up adds mutation-driven durable in-app alerts and [automatic classification of unresolved posted imports](classification.md), with explicit opt-in required for automatic category application.

A running timer test advances a controllable clock across four-hour boundaries and verifies actual job processing, no repeat imports in one bucket, clean stop, and webhook/poll imports sharing one canonical transaction/source alias. Production checks every 15 seconds and schedules one poll bucket per four hours while the process runs.

Alert tests verify concurrent deduplication, persistence through a new Store instance, unchanged-read stability, resolution and reopening after corrections/refunds/late imports, and export consistency. Alert state is recalculated by financial writes without report/export access; no external notification destination is required. Dashboard-closed tests cover ingestion, correction, classification, budget changes, refunds and affected rollover months.

Classification tests verify disabled-by-default behavior, automatic unresolved-import scheduling and on-demand retry, durable retries/Retry-After, restart, concurrent deduplication, bounded failure, configuration/credential fingerprints, single-connection pool safety, and preservation of manual overrides. The independent follow-up fixed pool exhaustion deadlock and made corrected credentials retry exhausted jobs without persisting secrets. By default suggestions require user review and saving. Automatic application is separately opt-in, validated and rechecks precedence; invalid/exhausted work falls back to review. A durable daily request counter and global provider-call serialization bound cost and concurrency.

A final independent review reran nine focused PostgreSQL tests for automatic classification and reactive alerts: all passed, none skipped. It checked real multi-connection concurrency, stale correction races, source-change requeue, automatic-work pause controls, review fallback, request quotas and dashboard-closed alert updates.

## Enhanced settings, reports and notifications

The final enhanced suite includes real PostgreSQL encryption/rotation, multi-month export and drilldown, local account edits, permanent-key Bedrock catalogue/model access checks, authenticated settings and Telegram pairing HTTP flows, thin webhook registration/recovery, import health/backfill, and durable notification delivery tests. Account disabling was removed at the owner’s request; all accounts remain included. Synthetic model tests are separate from read-only credential checks and explicitly acknowledge possible cost.

`npm run test:browser:enhancements` passed with mocked live-service endpoints for provider/model selection, credential preservation/clear controls, webhook reuse/recovery, Telegram nonce/group confirmation, SMTP test, notification content/retry controls, account editing/history pagination, import backfill, errors and desktop/mobile layouts. `npm run test:browser` passed against the actual local demo backend. All three original screenshot artifacts were refreshed.

The backup/restore rehearsal preserves all 20 tables, including four encrypted synthetic credential slots, pending/sent notification outbox records, alert transitions, webhook registration, account labels and bounded backfill parameters. The separate synthetic master key decrypts restored credentials; missing/wrong keys fail closed. No real external accounts, financial calls, sends or registrations were used.

Final packaging inspection moved the shared exact-money formatter into `shared/` and explicitly copies it into both Docker stages, preventing a runtime import of an omitted frontend source file. Docker base-image download remains the only container build blocker.

The final copy clarification removes contradictory legacy Redbark setup instructions. Settings now names both subscribed thin events, explains no sync provisioning or instant bank feed, and confirms independent polling. Transaction history explicitly means all imported records, with navigation to bounded backfill. Production build, both browser suites (including the new registration confirmation and backfill link), formatting and diff checks passed after this change.
