# Deploy Profe in a homelab

## Database selection and isolation

Use a dedicated database and database role. Default deployment uses `DATABASE_URL` (or `DATABASE_URL_FILE`) pointing to your LAN PostgreSQL. Restrict network access to the application host; use PostgreSQL TLS when traffic crosses an untrusted network. An unavailable database produces an error; the app never silently substitutes another database. Startup applies schema migrations; `npm run migrate` also runs them explicitly. Back up before upgrading.

Use distinct databases for `PROFE_MODE=demo` and `PROFE_MODE=live`. Demo fixtures are fictional and seeding is explicit. Never seed a database that contains real financial data. The demo is for local evaluation and should not be exposed publicly.

## Local configuration and secrets

```sh
cp .env.example .env
chmod 600 .env
mkdir -p secrets
chmod 700 secrets
npm ci
read -rsp "Profe password: " profe_password; printf "\n"
printf "%s" "$profe_password" | npm run password --silent
unset profe_password
```

Run the hidden password prompt above in Bash. The password command creates a salted scrypt hash for `PROFE_PASSWORD_HASH`; use a unique, long password. Generate `SESSION_SECRET` locally with `openssl rand -hex 32`. Do not paste secrets into chat or put them in Git. A password hash is still sensitive. Protect `.env`, backups and your secret files.

Each of `DATABASE_URL`, `PROFE_PASSWORD_HASH`, `SESSION_SECRET`, `REDBARK_API_KEY`, `REDBARK_WEBHOOK_SECRET` and `LLM_API_KEY` supports a corresponding `_FILE` variable. For file-based Docker configuration, leave the direct value empty, store the value in `./secrets/<name>`, and set the `_FILE` value to `/run/secrets/<name>`. Compose mounts this directory read-only. Ensure the container's non-root Node user (UID 1000) can read the files without making them world-readable. Docker/Swarm secrets mounted at `/run/secrets` work with the same convention.

In live mode set:

```dotenv
PROFE_MODE=live
APP_ORIGIN=https://profe.example.home
PROFE_CURRENCY=AUD
PROFE_TIMEZONE=Australia/Brisbane
DATABASE_URL_FILE=/run/secrets/database_url
PROFE_PASSWORD_HASH_FILE=/run/secrets/password_hash
SESSION_SECRET_FILE=/run/secrets/session_secret
```

Configure a trusted HTTPS reverse proxy (for example Caddy or nginx) to forward to `127.0.0.1:3001`, preserving the Host header. Use a certificate your browsers trust. `APP_ORIGIN` must equal the browser-visible HTTPS origin. Live sessions use secure cookies, so plain HTTP cannot provide a working live login. Password rotation and session-secret rotation should be followed by an app restart; rotating the session secret invalidates existing sessions. Keep the service private to your home network or VPN.

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

Only use this override if you choose a local database instead of your LAN instance. Generate a URL-safe password with `openssl rand -hex 32` and set `POSTGRES_PASSWORD` in `.env`:

```sh
docker compose -f compose.yaml -f compose.postgres.yaml up -d --build
# Demo fixtures only:
docker compose -f compose.yaml -f compose.postgres.yaml exec app npm run seed
```

The override explicitly replaces the database URL with `db:5432` and clears `DATABASE_URL_FILE`. PostgreSQL has no published port and persists in the named `profe_postgres` volume. It is not a fallback database. Do not use `docker compose down -v` unless you intend to delete that volume and have verified backups. An existing volume retains its original password; changing `POSTGRES_PASSWORD` alone does not rotate an initialized database password.

## Connect Redbark yourself

1. Finish HTTPS and live authentication setup against an empty live database.
2. Place your Redbark API key server-side and restart the app. Never enter it in a frontend form.
3. Use **Test connection** in Settings. The documented v2 beta version is `2026-10-01.wattle`, but availability is not assumed; successful testing is required for your account.
4. Configure the supported thin event destination and its signing secret as described in [Redbark integration](redbark.md). The destination must be reachable by Redbark over HTTPS; use a controlled reverse proxy or tunnel you configure yourself.
5. A failed connection test pauses integration ingestion only. Imported live data, corrections, budgets and exports remain available during provider downtime.
6. Review accounts, coverage and freshness. Set an explicit bounded backfill duration before importing history. A sync event or queued refresh does not imply fresh bank activity.

Optional LLM assistance remains disabled unless its provider URL, model and key are configured. Choose an inexpensive compatible provider yourself. Treat the remote provider as a recipient of the minimal context (a truncated description with long digit sequences redacted, and the permitted category names; no amounts, account IDs or credentials); no financial credentials should ever be sent. Rule/manual categories remain usable without it.

## Export, backup and restore

JSON export uses the same backend calculations and canonical transactions as the dashboard. The export contains a monthly report plus a separately labelled selection summary for active search/filter results, captured atomically. The JSON snapshot is useful for analysis; it is **not** a complete backup of observations, overrides, audit history, rules or jobs. A PostgreSQL backup preserves those.

For an external database, install PostgreSQL client tools at least as new as your server. Set `PGHOST`, `PGPORT`, `PGUSER`, `PGDATABASE`; use a protected `.pgpass` file for authentication instead of command-line passwords:

```sh
PGHOST=your-db PGPORT=5432 PGUSER=profe PGDATABASE=profe scripts/backup.sh ./backups
```

The script produces a custom-format consistent database snapshot with restrictive file permissions. Encrypt backups at rest, copy them off the application host, and record the application commit/version and non-secret configuration separately. Keep a separate encrypted backup of required secrets. Adopt a retention policy suitable for your finances. Stop ingestion during planned upgrades and take a backup first.

For bundled PostgreSQL:

```sh
mkdir -p backups
chmod 700 backups
docker compose -f compose.yaml -f compose.postgres.yaml exec -T db pg_dump -U profe -d profe -Fc --no-owner --no-acl > backups/profe.dump
chmod 600 backups/profe.dump
```

Restore into a **new empty database**, with the app stopped or pointed elsewhere. For external PostgreSQL:

```sh
PGHOST=your-db PGUSER=profe PGDATABASE=profe_restore PROFE_RESTORE_CONFIRM=profe_restore scripts/restore.sh backups/profe.dump
```

For bundled PostgreSQL, create an empty restore target with `createdb`, then pipe the backup into `pg_restore --single-transaction --exit-on-error --no-owner --no-acl` inside the database container. Do not overwrite a working database as your first restore test. Inspect restored counts, balances, dashboard totals, corrections and rules, then deliberately change the app's database URL and restart. A restore may contain pending durable jobs: validate integration configuration before enabling external network access. Regularly rehearse this process. A disposable loopback-only rehearsal script and the successful test evidence are documented in [restore evidence](restore-evidence.md).

## Policies and limits

AUD and Australia/Brisbane are defaults, configurable server-side. Keep currencies explicit; there is no FX conversion or cross-currency netting. Posted-only actuals use Redbark's posted date, falling back to its transaction date. Redbark returns calendar dates; configure its account timezone to match Profe (see the integration guide). Refunds reduce the relevant category in the refund month; they do not retroactively rewrite the original purchase month. Uncategorised expenses count toward actuals. Pending identities can change: ambiguous identity matches require human review, while two separate identical purchases must remain separate.

Positive category rollover is opt-in and applies only across consecutive configured budget months. Negative overspend does not silently roll forward. Allocations are planning entries and do not affect bank spending. Historical import or correction recomputes the affected rollovers deterministically. Provider balance snapshots are not proof transaction coverage is complete; incompatible type, time or coverage remains unreconciled with a reason.

Alerts are persisted and deduplicated in-app. Their state is recalculated in the same transaction as ingestion, corrections, accepted classifications and budget/rule changes, including affected rollover months. Dashboard visits are not required; external deliveries are not configured. Email, push, Slack delivery, multi-user roles, FX conversion, investment accounting, and audited disaster recovery automation are future work. Four-hour discovery and event-driven sync cannot promise instant bank freshness. Review source freshness and coverage before relying on totals.

Configured AI processes unresolved posted imports automatically using durable jobs, after manual overrides, rules and useful provider categories. `LLM_AUTO_CLASSIFY=false` disables automatic processing while keeping on-demand suggestions. `LLM_AUTO_APPLY=false` is the default: automatic category application requires explicit opt-in. `LLM_DAILY_REQUEST_LIMIT=20` and `LLM_BATCH_SIZE=5` bound request volume; see [classification behavior and limits](classification.md).
