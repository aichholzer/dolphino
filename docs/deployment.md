# Deploy dolphino in a homelab

For existing installations, first read [upgrade boundaries and credential recovery](upgrading.md). Stop every old app/worker process before starting the new release: lock and SMTP Message-ID namespaces have changed. Keep the same database/volume and current APP_SECRET. Saved version 1/2 credentials remain stored but unreadable; replace or clear them explicitly, with the documented SimpleFIN historical-mapping limitation.

## Database selection and isolation

Use a dedicated database and database role. Default deployment uses the standard individual `PGHOST`, `PGPORT` (default `5432`), `PGDATABASE`, `PGUSER` and `PGPASSWORD` settings pointing to your PostgreSQL server. All identity fields and a nonempty password are required; `PGPASSWORD_FILE` can supply the password. Restrict network access to the application host and explicitly choose transport security for off-host connections as described below. `DATABASE_URL` and `DATABASE_URL_FILE` are rejected with migration guidance, even when individual settings are also present. An unavailable database produces an error; the app never silently substitutes another database. Startup applies schema migrations; `npm run migrate` also runs them explicitly. Back up before upgrading.

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

For a new installation, before saving credentials in Settings, generate an independent encryption master key with `openssl rand -base64 32` and set `APP_SECRET` or `APP_SECRET_FILE`. Keep it outside PostgreSQL and back it up separately. Do not reuse an account password or bootstrap token. Missing or incorrect keys disable access to credentials while imported data remains usable. See [settings encryption and explicit offline key rotation](settings-security.md); changing the environment variable alone does not rotate ciphertext.

Each deployment secret `PGPASSWORD`, `DOLPHINO_BOOTSTRAP_TOKEN` and `APP_SECRET` supports a corresponding `_FILE` variable. Integration secrets are configured only through administrator Settings and stored encrypted in PostgreSQL; former integration environment variables and `_FILE` variants are ignored. For file-based Docker configuration, leave the direct value empty, store the value in `./secrets/<name>`, and set the `_FILE` value to `/run/secrets/<name>`. Compose mounts this directory read-only. Bundled PostgreSQL password files are the exception: use the dedicated `./postgres-secrets` mount described in the bundled section, keeping APP_SECRET and bootstrap secrets out of the database container. Ensure the container's non-root Node user (UID 1000) can read the files without making them world-readable. Docker/Swarm secrets mounted at `/run/secrets` work with the same convention.

In live mode set:

```dotenv
DOLPHINO_MODE=live
APP_ORIGIN=https://dolphino.example.home
DOLPHINO_CURRENCY=AUD
DOLPHINO_TIMEZONE=Australia/Brisbane
PGHOST=postgres.example.home
PGPORT=5432
PGDATABASE=dolphino
PGUSER=dolphino
PGPASSWORD_FILE=/run/secrets/postgres_password
PGSSLMODE=verify-full
# PGSSLROOTCERT is optional: system/public roots are the default.
DOLPHINO_BOOTSTRAP_TOKEN_FILE=/run/secrets/bootstrap_token
# Remove the bootstrap variable/file after first administrator setup.
APP_SECRET_FILE=/run/secrets/app_secret
```

Configure a trusted HTTPS reverse proxy (for example Caddy or nginx), preserving the Host header. A same-host proxy can forward to `127.0.0.1:3001`; a separate-host proxy needs a deliberate `APP_BIND` and network access policy. Set `TRUST_PROXY` to the immediate Caddy/proxy peer address observed by the app, and read [trusted proxies and forwarded addresses](reverse-proxy.md) before enabling upstream chains. Use a certificate your browsers trust. `APP_ORIGIN` must equal the browser-visible HTTPS origin. Live sessions use secure cookies, so plain HTTP cannot provide a working live login. Named account passwords and session revocation are managed through the app; legacy shared-password cookies are invalid after upgrading. Keep the service private to your home network or VPN.

## Default: existing LAN PostgreSQL

Set the database and other values in `.env` and create the `secrets` directory before starting:

```sh
docker compose up -d --build
```

The default Compose publishes only loopback port 3001 through `${APP_BIND:-127.0.0.1}`. For another proxy host, set `APP_BIND` to the app host’s reachable private address (or deliberately `0.0.0.0`) and restrict access to the proxy. The app speaks plain HTTP and Docker-published ports may bypass a host firewall’s ordinary INPUT rules. Do not expose an unauthenticated demo. `TRUST_PROXY` changes header trust, not reachability.

For a demo only, populate fixtures after the container starts:

```sh
docker compose exec app npm run seed
```

## PostgreSQL TLS

For external PostgreSQL, set `PGSSLMODE` explicitly. The app never retries with weaker TLS or plain TCP after a connection or certificate error.

- `verify-full` is recommended: TLS 1.2 or newer, a trusted certificate chain, and a certificate name/IP SAN matching `PGHOST`. Unset `PGSSLROOTCERT` and `PGSSLROOTCERT=system` both use Node’s bundled public CA roots plus the **runtime system** trust store. A publicly issued server certificate (including Neon’s) needs no custom CA file. A certificate being installed on a LAN database alone does not make a private/self-signed issuer trusted.
- `require` requests encryption only. It deliberately does **not** authenticate the server and emits a startup warning: an active attacker can impersonate PostgreSQL. This follows libpq’s encryption-only meaning rather than relying on node-postgres URL-parser behavior. To avoid libpq’s historical ambiguity, Dolphino rejects `PGSSLROOTCERT` with `require`; use `verify-full` to validate a CA/name, or remove the root setting only if unauthenticated TLS is intentional.
- `disable` deliberately uses plain TCP and rejects `PGSSLROOTCERT`. Use it only for a trusted isolated network. Loopback addresses/`localhost` default to this mode if unset; off-host addresses, including arbitrary Docker service names, require an explicit choice. The bundled override separately selects it when TLS variables are unset.

Dolphino does not implement `allow`, `prefer` or `verify-ca`. Verification failures, unsupported modes and missing/unreadable/invalid CA files stop startup/connection. Use the certificate’s DNS name as `PGHOST`, or ensure its IP SAN matches the configured IP. Do not disable verification to fix a hostname mismatch.

For a private CA, set `PGSSLROOTCERT` to an **absolute path** to its readable PEM trust bundle. This explicit bundle replaces the system/public roots for PostgreSQL only. It must contain certificates, never private keys; the maximum file size is 1 MiB. Native Node uses the path directly. For Docker, the system store means the container’s store, not the host’s. Use the supplied custom-CA override to mount a host file read-only:

```dotenv
PGSSLMODE=verify-full
PGSSLROOTCERT=/absolute/host/path/postgres-root-ca.pem
```

```sh
docker compose -f compose.yaml -f compose.postgres-ca.yaml up -d --build
```

The override maps that exact host file to `/run/postgres-ca/root.crt`; it never creates a missing source directory. Ensure UID 1000 can read it. Do not add this override for `PGSSLROOTCERT=system` or when no custom file is needed. A file already in the existing `./secrets` mount can instead use its absolute container path `/run/secrets/<file>` with the default Compose file. Neither route changes host trust settings.

These settings are applied identically by the server, migrations, demo seed, user recovery and key-rotation commands. PostgreSQL CLI tools use their own libpq semantics: when running backup/restore with public roots, explicitly set `PGSSLMODE=verify-full PGSSLROOTCERT=system` (PostgreSQL 16+) or a CA path supported by your CLI. The app’s `PGPASSWORD_FILE` convention is not automatically interpreted by libpq; use its protected `.pgpass` or an explicitly supplied environment password for those tools.

References: [PostgreSQL TLS modes](https://www.postgresql.org/docs/current/libpq-ssl.html), [node-postgres SSL options](https://node-postgres.com/features/ssl), [Node CA stores](https://nodejs.org/api/tls.html#tlsgetcacertificatestype), and [Neon’s TLS guidance](https://neon.com/blog/postgres-needs-better-connection-security-defaults).

## Explicit alternative: bundled PostgreSQL

Only use this override if you choose a local database instead of your LAN instance. **Existing installations must first follow [the upgrade instructions](upgrading.md)** and retain the actual existing volume/database/user. Do not create a replacement volume for an upgrade.

For a **new installation only**, generate a strong password with `openssl rand -hex 32`, set `PGPASSWORD` (or `PGPASSWORD_FILE`, leaving the direct value empty), `POSTGRES_VOLUME=dolphino_postgres`, `PGDATABASE=dolphino` and `PGUSER=dolphino` in `.env`, and leave `PGSSLMODE`/`PGSSLROOTCERT` unset. Passwords no longer need URI encoding. Then explicitly create the volume:

```sh
docker volume create dolphino_postgres
```

Start the explicitly configured database:

```sh
docker compose -f compose.yaml -f compose.postgres.yaml up -d --build
# Demo fixtures only:
docker compose -f compose.yaml -f compose.postgres.yaml exec app npm run seed
```

The override explicitly selects `PGHOST=db` and `PGPORT=5432`, using the same `PGDATABASE`, `PGUSER` and `PGPASSWORD`/`PGPASSWORD_FILE` for the app and PostgreSQL container. The official PostgreSQL image requires exactly one nonempty password source. For a bundled password file, put only that password in `./postgres-secrets/password`, set `PGPASSWORD_FILE=/run/postgres-secrets/password` and leave `PGPASSWORD` empty. The bundled override mounts this dedicated directory read-only into both containers; it never gives the database access to the app’s `./secrets` directory or APP_SECRET. Use a single-line bundled password, with at most one final LF/CRLF in the file: the official image/initdb removes line endings differently from the external app’s exact-byte password handling. When TLS variables are unset, this explicit bundled override sets `PGSSLMODE=disable` for its private Docker network; arbitrary service names and LAN hosts never receive that exemption. Explicit TLS settings are retained, so requesting TLS against the unconfigured bundled server fails instead of falling back. PostgreSQL has no published port and uses the exact external volume named by required `POSTGRES_VOLUME`. Compose refuses a missing volume and never automatically creates a replacement under a new project name. `PGDATABASE` and `PGUSER` are also required; preserve existing values on upgrades. It is not a fallback database. Do not use `docker compose down -v` unless you intend to delete that volume and have verified backups. An existing volume retains its original password; changing `PGPASSWORD` alone does not rotate an initialized database password.

## Connect Redbark yourself

1. Finish HTTPS and live authentication setup. New installations need an empty dedicated live database; upgrades retain the existing live database and APP_SECRET.
2. In administrator **Settings → Bank feeds → Redbark**, enter the write-only Redbark API key, API version and rolling backfill days, then save. These values are encrypted/stored in PostgreSQL and applied without a restart.
3. Use **Test connection** in Settings. The documented v2 beta version is `2026-10-01.wattle`, but availability is not assumed; successful testing is required for your account.
4. Register/reuse the supported thin event destination in Settings, which saves its encrypted signing secret. For an existing manually configured destination, explicitly enter its signing secret in Settings as described in [Redbark integration](redbark.md). The destination must be reachable by Redbark over HTTPS; use a controlled reverse proxy or tunnel you configure yourself.
5. A failed connection test pauses integration ingestion only. Imported live data, corrections, budgets and exports remain available during provider downtime.
6. Review accounts, coverage and freshness. Set an explicit bounded backfill duration before importing history. A sync event or queued refresh does not imply fresh bank activity.

Optional AI features remain disabled until configured and explicitly enabled in **Settings → AI features**. Save one OpenAI API key or one Bedrock region/permanent key pair for both classification and assistant (temporary session credentials are unsupported). Each feature has its own model/inference profile, limits and enable switch; the assistant also requires data-sharing acknowledgement. Bedrock automatically loads one catalog for both pickers. Shared connection changes pause both features for review; provider changes clear incompatible models and reset assistant sharing acknowledgement, while same-provider key/region changes keep models, consent and limits. Values are encrypted in PostgreSQL with `APP_SECRET`. Choose an inexpensive supported model yourself. Connection checks and synthetic model checks are separate; model tests disclose possible tiny inference costs. Treat the remote provider as a recipient of the minimal context (a truncated description with long digit sequences redacted, and the permitted category names; no amounts, account IDs or credentials); no financial credentials should ever be sent. Rule/manual categories remain usable without it.

## Upgrade environment-only integrations

Follow the [database integration upgrade checklist](database-integration-upgrade.md). Redbark and classification settings are now read only from PostgreSQL. Legacy integration environment variables are ignored, even if database settings are absent. No credentials, versions or limits are silently imported. Re-enter them in the administrator UI and test the saved configuration before enabling imports or AI automation. Existing encrypted settings and registration secrets remain stored, but this release reads only version 3 envelopes. Retired versions 1/2 require explicit replacement or clearing, not a blank save or a new APP_SECRET. Follow each provider's [recovery boundary](upgrading.md#recover-saved-integrations-explicitly), particularly SimpleFIN's unsupported historical relinking. Missing/unreadable configuration pauses or fails closed only the affected credential-dependent operation. Imports, manual overrides, jobs and notification configuration/outbox records remain in the existing database.

Deployment settings remain environment-based: PostgreSQL `PG*` connection/TLS settings, deployment mode, `HOST`/`PORT`, `APP_BIND`, `TRUST_PROXY`, `APP_ORIGIN`, bootstrap proof and `APP_SECRET`. Currency/timezone environment values remain defaults. Preserve the intended values while explicitly converting old branded aliases to the current `DOLPHINO_*` names; unsupported aliases are no longer read. Retain the current APP_SECRET with the matching database. Generating a new key does not unlock existing ciphertext, and a matching old key does not make retired envelope formats readable in this release.

## Export, backup and restore

JSON export uses the same backend calculations and canonical transactions as the dashboard. The export contains a monthly report plus a separately labelled selection summary for active search/filter results, captured atomically. The JSON snapshot is useful for analysis; it is **not** a complete backup of observations, overrides, audit history, rules or jobs. A PostgreSQL backup preserves those.

For an external database, install PostgreSQL client tools at least as new as your server. Set `PGHOST`, `PGPORT`, `PGUSER`, `PGDATABASE`; use a protected `.pgpass` file for authentication instead of command-line passwords:

```sh
PGHOST=your-db PGPORT=5432 PGUSER=dolphino PGDATABASE=dolphino scripts/backup.sh ./backups
```

The script produces a custom-format consistent database snapshot with restrictive file permissions. Encrypt backups at rest, copy them off the application host, and record the application commit/version and non-secret configuration separately. Keep a separate encrypted backup of required secrets, especially `APP_SECRET`, matched to the database backup version. A database dump alone cannot recover Settings credentials. Keep the matching application version too: pre-upgrade version 1/2 envelopes need a compatible earlier application to decrypt; the current application deliberately rejects them even with the matching key. Adopt a retention policy suitable for your finances. Stop ingestion during planned upgrades and take a backup first.

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

For bundled PostgreSQL, create an empty restore target with `createdb`, then pipe the backup into `pg_restore --single-transaction --exit-on-error --no-owner --no-acl` inside the database container. Do not overwrite a working database as your first restore test. Inspect restored counts, balances, dashboard totals, corrections and rules, then deliberately change the app's explicit `PGDATABASE`/connection settings and restart. A restore may contain pending durable jobs: validate integration configuration before enabling external network access. Regularly rehearse this process. A disposable loopback-only [restore rehearsal](testing.md#restore-rehearsal) exercises the same scripts.

## Policies and limits

AUD and Australia/Brisbane are defaults, configurable server-side. Keep currencies explicit; there is no FX conversion or cross-currency netting. Posted-only actuals use Redbark's posted date, falling back to its transaction date. Redbark returns calendar dates; configure its account timezone to match dolphino (see the integration guide). Refunds reduce the relevant category in the refund month; they do not retroactively rewrite the original purchase month. Uncategorised expenses count toward actuals. Pending identities can change: ambiguous identity matches require human review, while two separate identical purchases must remain separate.

Positive category rollover is opt-in and applies only across consecutive configured budget months. Negative overspend does not silently roll forward. Allocations are planning entries and do not affect bank spending. Historical import or correction recomputes the affected rollovers deterministically. Provider balance snapshots are not proof transaction coverage is complete; incompatible type, time or coverage remains unreconciled with a reason.

Alerts are persisted and deduplicated in-app. Their state is recalculated in the same transaction as ingestion, corrections, accepted classifications and budget/rule changes, including affected rollover months. Dashboard visits are not required; optional Telegram and SMTP delivery use an encrypted configuration and durable outbox; see [notification setup](notifications.md). Push, Slack delivery, multi-user roles, FX conversion, investment accounting, and audited disaster recovery automation are future work. Four-hour discovery and event-driven sync cannot promise instant bank freshness. Review source freshness and coverage before relying on totals.

When enabled in Settings, AI can process unresolved posted imports automatically using durable jobs, after manual overrides, rules and useful provider categories. The independent automatic-suggestions switch disables automatic processing while keeping on-demand suggestions; the master enable switch pauses both. Automatic category application requires explicit opt-in and is off by default. The Settings request limit (default 20 per UTC day) and batch size (default 5) bound request volume; see [classification behavior and limits](classification.md).

Account labels and descriptions in dolphino are local overrides, retained across provider refreshes. Every connected account remains included in synchronization, classification, the overview and budgets; account disabling is not supported. Clicking an account opens its paginated transaction history, with adjustable dates and an all-imported-history option. This includes only records already stored in dolphino; use Settings → Data → Import health & history for explicit bounded backfill of older provider records. Confirmed internal transfers and card repayments remain excluded from spending, including in an account-scoped list. The overview offers 1, 2, 3, 4, 5 or 6 calendar months ending in the selected month, a monthly comparison and aggregate drilldowns; the current month is marked partial. Monthly budget caps remain scoped to the selected final month.

JSON exports include the complete selection, irrespective of the transaction table's current page. For a month/period export, `summary` uses the same full-period report as the overview and `selectionSummary` applies optional transaction filters; both scopes are labeled. Date-range and all-history exports summarize exactly the exported records. Monetary values remain integer minor-unit strings throughout.

## Database deployment-mode lock

The server, migration command and demo seed bind a database to `demo` or `live` before other initialization. Switching a bound database to the other mode fails at startup; it never silently opens live settings through anonymous demo access. Use separate databases. Legacy live users/ledger rows or stored credentials prevent a demo startup. Legacy demo ledger rows prevent live startup. An ambiguous old demo database with saved credentials should be replaced with a fresh fictional demo database; do not delete the marker to bypass this safeguard. Preserve the mode table in backups. Normal live upgrades retain the existing ledger and settings.
