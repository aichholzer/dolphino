# dolphino

A self-hosted, household personal finance service: React, Tailwind and accessible Radix UI components; a separate plain-JavaScript Rayo REST API; PostgreSQL; and an independent accounting engine. The first MVP includes fictional demo data and an opt-in Redbark integration. It does not use Actual.

## Run the fictional demo

Requirements: Node.js 24+, npm, and an explicitly configured PostgreSQL database. Copy `.env.example` to `.env` and set `PGHOST`, `PGPORT` (default `5432`), `PGDATABASE`, `PGUSER` and `PGPASSWORD` for a **dedicated demo database**. For off-host PostgreSQL explicitly select `PGSSLMODE=verify-full` (recommended), `require` (encryption only) or `disable` (plain TCP); see [PostgreSQL TLS](docs/deployment.md#postgresql-tls). The commands below load `.env` explicitly. Never point the demo seed at your live database.

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

See [deployment and backup instructions](docs/deployment.md) and [Redbark integration](docs/redbark.md). Default Compose uses only your configured external PostgreSQL. Bundled PostgreSQL is an explicit override, never an outage fallback. `DATABASE_URL`/`DATABASE_URL_FILE` are retired: move the same host/database/user/password into the individual `PG*` settings before upgrading. `PGPASSWORD_FILE` remains available for a mounted password secret. Optional `TRUST_PROXY` accepts only explicit proxy IPs/CIDRs; see [reverse-proxy configuration](docs/reverse-proxy.md).

```sh
npm test
npm run build
npm run lint
npm run format:check
# Run PostgreSQL integration checks using a disposable database:
# Set PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD for a disposable database,
# plus PGSSLMODE for off-host connections; keep passwords out of shell history.
npm test
```

`npm run check` runs lint, formatting checks, tests and the production build. The synthetic TLS tests require the `openssl` executable. Database-dependent tests skip without a configured disposable PostgreSQL database; browser checks remain separate.

### Code style and static checks

Run `npm run lint:fix` to apply safe ESLint fixes, then `npm run format` to format source, tests, documentation and supported configuration files. Both tools exclude dependencies, build output and generated verification artifacts; Prettier also leaves the generated lockfile untouched.

`eslint.config.js` applies ESLint's recommended rules, requires braces for every conditional and loop, and rejects unused variables. Intentionally unused arguments may start with `_`, and object-rest omissions are allowed. Node and browser globals are scoped to their respective files. ESLint 10 tracks JSX component references natively, so unused-variable checking remains enabled for React code without an extra compatibility plugin.

`.prettierrc.json` defines 120-column lines, two-space indentation, single quotes, semicolons, no trailing commas, bracket spacing and parentheses around arrow-function parameters. Formatting checks cover the repository rather than a narrow source-only file list.

The service is an MVP for a trusted household homelab. Put live mode behind HTTPS and maintain tested encrypted backups. No production deployment, real financial connection, external account creation, or external permission change is needed to try the demo.

Browser checks against the running demo: `node scripts/browser-check.mjs` (set `CHROMIUM_PATH` if Chromium is elsewhere). See [verification evidence](docs/verification.md).

Follow-up evidence: [independent review](docs/review.md), [backup/restore rehearsal](docs/restore-evidence.md), and [automatic classification policy](docs/classification.md).

See [enhancements and verified boundaries](docs/enhancements.md), [encrypted settings](docs/settings-security.md), [provider configuration](docs/providers.md), [Telegram/SMTP notifications](docs/notifications.md), and [import health](docs/import-health.md).

For new live installs and upgrades from the shared-password version, complete [restricted first-administrator setup](docs/household-auth.md) before allowing household access. Public first-visitor signup is disabled.

See [assistant setup, tool catalog and limits](docs/assistant.md).

The [isolated security assessment](docs/security-assessment.md) documents tested attacks, fixed findings and remaining deployment limits. This is not a security certification.

Upgrading an existing installation? Read [rename compatibility and volume preservation](docs/rename-upgrade.md) before changing directories or Compose configuration. Keep APP_SECRET and your existing database/volume.

### Optional SimpleFIN

An administrator can connect a compatible public-HTTPS SimpleFIN v1 provider from Settings. It is paused by default and uses the existing encrypted database credential vault. Direct Redbark remains primary. See [setup, source ownership and limitations](docs/simplefin.md).

See [code organization and maintenance](docs/architecture.md) for module boundaries, route-access contracts and the development checks.
