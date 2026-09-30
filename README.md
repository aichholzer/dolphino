# Profe

A self-hosted, household personal finance service: React, Tailwind and accessible Radix UI components; a separate plain-JavaScript Rayo REST API; PostgreSQL; and an independent accounting engine. The first MVP includes fictional demo data and an opt-in Redbark integration. It does not use Actual.

## Run the fictional demo

Requirements: Node.js 24+, npm, and an explicitly configured PostgreSQL database. Copy `.env.example` to `.env` and set `DATABASE_URL` to a **dedicated demo database**. The commands below load `.env` explicitly. Never point the demo seed at your live database.

```sh
npm ci
npm run build
node --env-file=.env backend/src/seed.js
node --env-file=.env backend/src/server.js
```

Open <http://localhost:3001>. Demo mode is prominently labelled and makes no live financial calls. For development, set `APP_ORIGIN=http://localhost:5173`, run the backend above and `npm run dev --workspace frontend` in another terminal. Use port 5173 for browser requests so mutation origin checks match.

## What is included

- Income, expenses, cash flow, category charts, source account balances and freshness.
- Search and filters, transaction corrections, exact splits, rules and a review queue.
- Monthly category caps, persistent deduplicated in-app overspend alerts, allocations and opt-in positive rollover.
- PostgreSQL provider observations, canonical identities, independent manual overrides and audit history.
- Durable webhook receipts and jobs, four-hour Redbark account discovery/reconciliation, bounded backfill and a connection test.
- Optional configured AI classifies unresolved posted imports through durable, cost-limited jobs after manual/rule/provider classification. Suggestions require review unless automatic application is explicitly enabled; on-demand retry remains available.
- Named household accounts, administrator-managed invitations and revocable database sessions for live data, JSON export, and backup/restore scripts.

Amounts travel as integer minor-unit strings; calculations use integer arithmetic. Posted transactions drive actual spending, pending items are separate, refunds reduce spending on their posted date, and transfers/card repayments do not count as expenses. Budget allocations do not create bank transactions. Account balances remain provider snapshots; unsupported reconciliation is explicitly marked rather than repaired with invented entries.

## Deployment and verification

See [deployment and backup instructions](docs/deployment.md) and [Redbark integration](docs/redbark.md). Default Compose uses only your configured external PostgreSQL. Bundled PostgreSQL is an explicit override, never an outage fallback.

```sh
npm test
npm run build
npm run lint
# Run PostgreSQL integration checks using a disposable database:
DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/profe_test npm test
```

The service is an MVP for a trusted household homelab. Put live mode behind HTTPS and maintain tested encrypted backups. No production deployment, real financial connection, external account creation, or external permission change is needed to try the demo.

Browser checks against the running demo: `node scripts/browser-check.mjs` (set `CHROMIUM_PATH` if Chromium is elsewhere). See [verification evidence](docs/verification.md).

Follow-up evidence: [independent review](docs/review.md), [backup/restore rehearsal](docs/restore-evidence.md), and [automatic classification policy](docs/classification.md).

See [enhancements and verified boundaries](docs/enhancements.md), [encrypted settings](docs/settings-security.md), [provider configuration](docs/providers.md), [Telegram/SMTP notifications](docs/notifications.md), and [import health](docs/import-health.md).

For new live installs and upgrades from the shared-password version, complete [restricted first-administrator setup](docs/household-auth.md) before allowing household access. Public first-visitor signup is disabled.
