# Deploy dolphino in a homelab

## Database selection and isolation

Use a dedicated database and database role. Default deployment uses `DATABASE_URL` (or `DATABASE_URL_FILE`) pointing to your LAN PostgreSQL. Restrict network access to the application host; use PostgreSQL TLS when traffic crosses an untrusted network. An unavailable database produces an error; the app never silently substitutes another database. Startup applies schema migrations; `npm run migrate` also runs them explicitly. Back up before upgrading.

Use distinct databases for `DOLPHINO_MODE=demo` and `DOLPHINO_MODE=live`. Demo fixtures are fictional and seeding is explicit. Never seed a database that contains real financial data. The demo is for local evaluation and should not be exposed publicly.

## Local configuration and secrets

```sh
cp .env.example .env
chmod 600 .env
mkdir -p secrets
chmod 700 secrets
npm ci
# First live setup only; never print or commit this installation proof.
(umask 077; openssl rand -hex 32 > secrets/bootstrap_token)
```

For named household authentication, follow [restricted first-administrator setup and shared-password upgrade](household-auth.md). Configure `DOLPHINO_BOOTSTRAP_TOKEN_FILE=/run/secrets/bootstrap_token` for first setup, then remove it after the administrator is established. Keep the app private during setup. Existing ledger data and APP_SECRET are preserved on upgrade; old shared-password sessions are invalidated. Do not paste secrets into chat or put them in Git. Protect `.env`, backups and secret files.

Before saving credentials in Settings, generate an independent encryption master key with `openssl rand -base64 32` and set `APP_SECRET` or `APP_SECRET_FILE`. Keep it outside PostgreSQL and back it up separately. Do not reuse an account password or bootstrap token. Missing or incorrect keys disable access to credentials while imported data remains usable. See [settings encryption and explicit offline key rotation](settings-security.md); changing the environment variable alone does not rotate ciphertext.

Each deployment secret `DATABASE_URL`, `DOLPHINO_BOOTSTRAP_TOKEN` and `APP_SECRET` supports a corresponding `_FILE` variable. Integration secrets are configured only through administrator Settings and stored encrypted in PostgreSQL; former integration environment variables and `_FILE` variants are ignored. For file-based Docker configuration, leave the direct value empty, store the value in `./secrets/<name>`, and set the `_FILE` value to `/run/secrets/<name>`. Compose mounts this directory read-only. Ensure the container's non-root Node user (UID 1000) can read the files without making them world-readable. Docker/Swarm secrets mounted at `/run/secrets` work with the same convention.

In live mode set:

```dotenv
DOLPHINO_MODE=live
APP_ORIGIN=https://dolphino.example.home
DOLPHINO_CURRENCY=AUD
DOLPHINO_TIMEZONE=Australia/Brisbane
DATABASE_URL_FILE=/run/secrets/database_url
DOLPHINO_BOOTSTRAP_TOKEN_FILE=/run/secrets/bootstrap_token
# Remove the bootstrap variable/file after first administrator setup.
APP_SECRET_FILE=/run/secrets/app_secret
```

Configure a trusted HTTPS reverse proxy (for example Caddy or nginx) to forward to `127.0.0.1:3001`, preserving the Host header. Use a certificate your browsers trust. `APP_ORIGIN` must equal the browser-visible HTTPS origin. Live sessions use secure cookies, so plain HTTP cannot provide a working live login. Named account passwords and session revocation are managed through the app; legacy shared-password cookies are invalid after upgrading. Keep the service private to your home network or VPN.

## Default: existing LAN PostgreSQL

Set the database and other values in `.env` and create the `secrets` directory before starting:

```sh
docker compose up -d --build
```

The default Compose publishes only loopback port 3001. Connect the reverse proxy on that host. To use another proxy host, deliberately configure a private bind address and firewall; do not expose an unauthenticated demo.

For a demo only, populate fixtures after the container starts:

```sh
docker compose exec app npm run seed
```

## Explicit alternative: bundled PostgreSQL

Only use this override if you choose a local database instead of your LAN instance. **Existing installations must first follow [the rename upgrade instructions](rename-upgrade.md)** and retain the actual existing volume/database/user. Do not create a replacement volume for an upgrade.

For a **new installation only**, generate a URL-safe password with `openssl rand -hex 32`, set `POSTGRES_PASSWORD`, `POSTGRES_VOLUME=dolphino_postgres`, `POSTGRES_DB=dolphino` and `POSTGRES_USER=dolphino` in `.env`, then explicitly create the volume:

```sh
docker volume create dolphino_postgres
```

Start the explicitly configured database:

```sh
docker compose -f compose.yaml -f compose.postgres.yaml up -d --build
# Demo fixtures only:
docker compose -f compose.yaml -f compose.postgres.yaml exec app npm run seed
```

The override explicitly replaces the database URL with `db:5432` and clears `DATABASE_URL_FILE`. PostgreSQL has no published port and uses the exact external volume named by required `POSTGRES_VOLUME`. Compose refuses a missing volume and never automatically creates a replacement under a new project name. `POSTGRES_DB` and `POSTGRES_USER` are also required; preserve existing values on upgrades. It is not a fallback database. Do not use `docker compose down -v` unless you intend to delete that volume and have verified backups. An existing volume retains its original password; changing `POSTGRES_PASSWORD` alone does not rotate an initialized database password.

## Connect Redbark yourself

1. Finish HTTPS and live authentication setup. New installations need an empty dedicated live database; upgrades retain the existing live database and APP_SECRET.
2. In administrator **Settings → Redbark settings**, enter the write-only Redbark API key, API version and rolling backfill days, then save. These values are encrypted/stored in PostgreSQL and applied without a restart.
3. Use **Test connection** in Settings. The documented v2 beta version is `2026-10-01.wattle`, but availability is not assumed; successful testing is required for your account.
4. Register/reuse the supported thin event destination in Settings, which saves its encrypted signing secret. For an existing manually configured destination, explicitly enter its signing secret in Settings as described in [Redbark integration](redbark.md). The destination must be reachable by Redbark over HTTPS; use a controlled reverse proxy or tunnel you configure yourself.
5. A failed connection test pauses integration ingestion only. Imported live data, corrections, budgets and exports remain available during provider downtime.
6. Review accounts, coverage and freshness. Set an explicit bounded backfill duration before importing history. A sync event or queued refresh does not imply fresh bank activity.

Optional LLM assistance remains disabled until a provider is configured and enabled in Settings. Select OpenAI with a manually entered model and API key, or Bedrock with region, model/inference profile, permanent access key ID and secret key (temporary session credentials are unsupported). Values are encrypted in PostgreSQL with `APP_SECRET`. Choose an inexpensive supported model yourself. Connection checks and synthetic model checks are separate; model tests disclose possible tiny inference costs. Treat the remote provider as a recipient of the minimal context (a truncated description with long digit sequences redacted, and the permitted category names; no amounts, account IDs or credentials); no financial credentials should ever be sent. Rule/manual categories remain usable without it.

## Upgrade environment-only integrations

Follow the [database integration upgrade checklist](database-integration-upgrade.md). Redbark and classification settings are now read only from PostgreSQL. Legacy integration environment variables are ignored, even if database settings are absent. No credentials, versions or limits are silently imported. Re-enter them in the administrator UI and test the saved configuration before enabling imports or AI automation. Existing encrypted settings and registration secrets are retained; missing configuration pauses only the affected integration. Imports, manual overrides, jobs and notification configuration/outbox records remain in the existing database.

Deployment settings remain environment-based: database URL/file, deployment mode, `HOST`/`PORT`, `APP_BIND`, `APP_ORIGIN`, bootstrap proof and `APP_SECRET`. Currency/timezone environment values remain defaults. Do not change these during this migration. Retain the exact APP_SECRET with the matching restored database; generating a new key does not unlock existing ciphertext.

## Export, backup and restore

JSON export uses the same backend calculations and canonical transactions as the dashboard. The export contains a monthly report plus a separately labelled selection summary for active search/filter results, captured atomically. The JSON snapshot is useful for analysis; it is **not** a complete backup of observations, overrides, audit history, rules or jobs. A PostgreSQL backup preserves those.

For an external database, install PostgreSQL client tools at least as new as your server. Set `PGHOST`, `PGPORT`, `PGUSER`, `PGDATABASE`; use a protected `.pgpass` file for authentication instead of command-line passwords:

```sh
PGHOST=your-db PGPORT=5432 PGUSER=dolphino PGDATABASE=dolphino scripts/backup.sh ./backups
```

The script produces a custom-format consistent database snapshot with restrictive file permissions. Encrypt backups at rest, copy them off the application host, and record the application commit/version and non-secret configuration separately. Keep a separate encrypted backup of required secrets, especially `APP_SECRET`, matched to the database backup version. A database dump alone cannot recover Settings credentials. Adopt a retention policy suitable for your finances. Stop ingestion during planned upgrades and take a backup first.

For bundled PostgreSQL:

```sh
mkdir -p backups
chmod 700 backups
docker compose -f compose.yaml -f compose.postgres.yaml exec -T db pg_dump -U dolphino -d dolphino -Fc --no-owner --no-acl > backups/dolphino.dump
chmod 600 backups/dolphino.dump
```

Restore into a **new empty database**, with the app stopped or pointed elsewhere. For external PostgreSQL:

```sh
PGHOST=your-db PGUSER=dolphino PGDATABASE=dolphino_restore DOLPHINO_RESTORE_CONFIRM=dolphino_restore scripts/restore.sh backups/dolphino.dump
```

For bundled PostgreSQL, create an empty restore target with `createdb`, then pipe the backup into `pg_restore --single-transaction --exit-on-error --no-owner --no-acl` inside the database container. Do not overwrite a working database as your first restore test. Inspect restored counts, balances, dashboard totals, corrections and rules, then deliberately change the app's database URL and restart. A restore may contain pending durable jobs: validate integration configuration before enabling external network access. Regularly rehearse this process. A disposable loopback-only rehearsal script and the successful test evidence are documented in [restore evidence](restore-evidence.md).

## Policies and limits

AUD and Australia/Brisbane are defaults, configurable server-side. Keep currencies explicit; there is no FX conversion or cross-currency netting. Posted-only actuals use Redbark's posted date, falling back to its transaction date. Redbark returns calendar dates; configure its account timezone to match dolphino (see the integration guide). Refunds reduce the relevant category in the refund month; they do not retroactively rewrite the original purchase month. Uncategorised expenses count toward actuals. Pending identities can change: ambiguous identity matches require human review, while two separate identical purchases must remain separate.

Positive category rollover is opt-in and applies only across consecutive configured budget months. Negative overspend does not silently roll forward. Allocations are planning entries and do not affect bank spending. Historical import or correction recomputes the affected rollovers deterministically. Provider balance snapshots are not proof transaction coverage is complete; incompatible type, time or coverage remains unreconciled with a reason.

Alerts are persisted and deduplicated in-app. Their state is recalculated in the same transaction as ingestion, corrections, accepted classifications and budget/rule changes, including affected rollover months. Dashboard visits are not required; optional Telegram and SMTP delivery use an encrypted configuration and durable outbox; see [notification setup](notifications.md). Push, Slack delivery, multi-user roles, FX conversion, investment accounting, and audited disaster recovery automation are future work. Four-hour discovery and event-driven sync cannot promise instant bank freshness. Review source freshness and coverage before relying on totals.

When enabled in Settings, AI can process unresolved posted imports automatically using durable jobs, after manual overrides, rules and useful provider categories. The independent automatic-suggestions switch disables automatic processing while keeping on-demand suggestions; the master enable switch pauses both. Automatic category application requires explicit opt-in and is off by default. The Settings request limit (default 20 per UTC day) and batch size (default 5) bound request volume; see [classification behavior and limits](classification.md).

Account labels and descriptions in dolphino are local overrides, retained across provider refreshes. Every connected account remains included in synchronization, classification, the overview and budgets; account disabling is not supported. Clicking an account opens its paginated transaction history, with adjustable dates and an all-imported-history option. This includes only records already stored in dolphino; use Settings → Import health & history for explicit bounded backfill of older provider records. Confirmed internal transfers and card repayments remain excluded from spending, including in an account-scoped list. The overview offers 1, 2, 3, 4 or 6 calendar months ending in the selected month, a monthly comparison and aggregate drilldowns; the current month is marked partial. Monthly budget caps remain scoped to the selected final month.

JSON exports include the complete selection, irrespective of the transaction table's current page. For a month/period export, `summary` uses the same full-period report as the overview and `selectionSummary` applies optional transaction filters; both scopes are labeled. Date-range and all-history exports summarize exactly the exported records. Monetary values remain integer minor-unit strings throughout.

## Database deployment-mode lock

The server, migration command and demo seed bind a database to `demo` or `live` before other initialization. Switching a bound database to the other mode fails at startup; it never silently opens live settings through anonymous demo access. Use separate databases. Legacy live users/ledger rows or stored credentials prevent a demo startup. Legacy demo ledger rows prevent live startup. An ambiguous old demo database with saved credentials should be replaced with a fresh fictional demo database; do not delete the marker to bypass this safeguard. Preserve the mode table in backups. Normal live upgrades retain the existing ledger and settings.
