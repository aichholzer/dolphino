# dolphino

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
- Optional read-only AI assistant with private temporary chats, scoped finance tools, exact reports and separate provider settings.
- Named household accounts, administrator-managed invitations and revocable database sessions for live data, JSON export, and backup/restore scripts.

Amounts travel as integer minor-unit strings; calculations use integer arithmetic. Posted transactions drive actual spending, pending items are separate, refunds reduce spending on their posted date, and transfers/card repayments do not count as expenses. Budget allocations do not create bank transactions. Account balances remain provider snapshots; unsupported reconciliation is explicitly marked rather than repaired with invented entries.

## Integration settings and upgrades

An administrator configures Redbark credentials, API version and rolling backfill window, classification provider/model/credentials and automation limits, the read-only assistant, and notifications in **Settings**. Integration values are stored only in PostgreSQL; credentials are write-only and encrypted with the deployment's `APP_SECRET`. Saved changes apply without restarting the app. OpenAI and Bedrock use fixed secure provider endpoints; custom base URLs are unsupported.

**Existing environment-only installations:** manually re-enter Redbark and classification configuration in Settings after upgrading. Old integration environment variables are ignored, never silently imported or used as a fallback. Unconfigured integrations pause; imported financial data, overrides, queued jobs and notifications remain preserved. Keep the same database/volume and matching `APP_SECRET`. Deployment database selection, mode, `HOST`/`PORT`, `APP_BIND`, origin/bootstrap settings and currency/timezone defaults remain environment-based. Follow the [database integration upgrade checklist](docs/database-integration-upgrade.md).

## Deployment and verification

See [deployment and backup instructions](docs/deployment.md) and [Redbark integration](docs/redbark.md). Default Compose uses only your configured external PostgreSQL. Bundled PostgreSQL is an explicit override, never an outage fallback.

```sh
npm test
npm run build
npm run lint
# Run PostgreSQL integration checks using a disposable database:
DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/dolphino_test npm test
```

The service is an MVP for a trusted household homelab. Put live mode behind HTTPS and maintain tested encrypted backups. No production deployment, real financial connection, external account creation, or external permission change is needed to try the demo.

Browser checks against the running demo: `node scripts/browser-check.mjs` (set `CHROMIUM_PATH` if Chromium is elsewhere). See [verification evidence](docs/verification.md).

Follow-up evidence: [independent review](docs/review.md), [backup/restore rehearsal](docs/restore-evidence.md), and [automatic classification policy](docs/classification.md).

See [enhancements and verified boundaries](docs/enhancements.md), [encrypted settings](docs/settings-security.md), [provider configuration](docs/providers.md), [Telegram/SMTP notifications](docs/notifications.md), and [import health](docs/import-health.md).

For new live installs and upgrades from the shared-password version, complete [restricted first-administrator setup](docs/household-auth.md) before allowing household access. Public first-visitor signup is disabled.

See [assistant setup, tool catalog and limits](docs/assistant.md).

The [isolated security assessment](docs/security-assessment.md) documents tested attacks, fixed findings and remaining deployment limits. This is not a security certification.

Upgrading an existing installation? Read [rename compatibility and volume preservation](docs/rename-upgrade.md) before changing directories or Compose configuration. Keep APP_SECRET and your existing database/volume.
