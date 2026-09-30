# MVP verification — 30 September 2026

All records used during development and verification are fictional. No production credentials or financial services were used. Tests create temporary PostgreSQL schemas and remove them afterward. Use a disposable database with schema creation permissions.

## Commands and outcomes

- `DATABASE_URL=postgresql://profe@127.0.0.1:54329/profe_test npm test`: passed all 31 tests, including real PostgreSQL integration. No database tests skipped in the final run.
- `npm run build`: production Vite build passed.
- `npm run lint`: backend/script JavaScript syntax checks passed.
- `node scripts/browser-check.mjs`: Chromium desktop (1440px) and mobile (390px) checks passed. Checked income/spending, refund drilldown, excluded repayment, two genuine identical coffees, invalid split rejection, cancelled edit, budget save, account freshness, disabled demo connection test, JSON export, and API failure/retry recovery. No uncaught browser errors or viewport overflow.
- `npm audit --omit=dev --audit-level=high`: zero known production dependency vulnerabilities at verification time.
- Both external-database and bundled-database Compose configurations parsed with `docker compose config --format json`; assertions confirmed the default has only the external URL, the override selects `db` and clears `DATABASE_URL_FILE`, and bundled PostgreSQL publishes no port.
- Actual isolated backup/restore rehearsal passed using the repository shell scripts and PostgreSQL 18 client tools built under `/tmp`: all rows across 14 public tables and complete financial reports matched. Both new fictional databases and the dump were deleted. See [restore evidence](restore-evidence.md).

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
- In-app alerts only. Email/push delivery, multi-user access, foreign-exchange conversion and broader provider adapters are future work.

## Follow-up review and verification

An [independent review](review.md) found and corrected repeated review warnings and non-UTC calendar-date conversion. Follow-up added durable in-app alert identities and a [durable on-demand AI suggestion queue](classification.md), without automatic acceptance or bulk AI classification.

A running timer test advances a controllable clock across four-hour boundaries and verifies actual job processing, no repeat imports in one bucket, clean stop, and webhook/poll imports sharing one canonical transaction/source alias. Production checks every 15 seconds and schedules one poll bucket per four hours while the process runs.

Alert tests verify concurrent deduplication, persistence through a new Store instance, unchanged-read stability, resolution and reopening after corrections/refunds/late imports, and export consistency. Alert state is refreshed when a report/export is requested; there is no external notification delivery.

Classification tests verify disabled-by-default behavior, explicit on-demand scheduling, durable retries/Retry-After, restart, concurrent deduplication, bounded failure, configuration/credential fingerprints, single-connection pool safety, and preservation of manual overrides. The independent follow-up fixed pool exhaustion deadlock and made corrected credentials retry exhausted jobs without persisting secrets. Suggestions require user review and saving; exhausted jobs fall back to manual classification.
