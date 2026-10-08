# Deployment

Dolphino runs as one Node.js container in front of a PostgreSQL database. It is built for a home network or VPN, behind an HTTPS reverse proxy.

## Install

You need Docker with Compose, a PostgreSQL database (your own, or the bundled container described below) and a hostname with a certificate your browsers trust.

1. Copy the example configuration and create a folder for secrets. Compose mounts `./secrets` read-only at `/run/secrets`. The container runs as UID 1000; that user must be able to read the files:

   ```sh
   cp .env.example .env && chmod 600 .env
   mkdir -p secrets && chmod 700 secrets
   (umask 077; openssl rand -base64 32 > secrets/app_secret)
   (umask 077; openssl rand -hex 32 > secrets/bootstrap_token)
   ```

2. Set these values in `.env`:

   ```dotenv
   DOLPHINO_MODE=live
   APP_ORIGIN=https://finance.example.com
   APP_SECRET_FILE=/run/secrets/app_secret
   DOLPHINO_BOOTSTRAP_TOKEN_FILE=/run/secrets/bootstrap_token
   PGHOST=postgres.example.home
   PGPORT=5432
   PGDATABASE=dolphino
   PGUSER=dolphino
   PGPASSWORD=your-database-password
   PGSSLMODE=verify-full
   DOLPHINO_CURRENCY=AUD
   DOLPHINO_TIMEZONE=Australia/Brisbane
   ```

3. Start it:

   ```sh
   docker compose up -d --build
   ```

4. Point your reverse proxy at `127.0.0.1:3001`. `APP_ORIGIN` must be exactly the address your browser shows. Live mode uses secure cookies, and signing in over plain HTTP does not work.
5. Open the app and enter the contents of `secrets/bootstrap_token` to create the first administrator. Then remove `DOLPHINO_BOOTSTRAP_TOKEN_FILE` from `.env`, delete the token file and run `docker compose up -d`.
6. Set up bank feeds, notifications and AI features in **Settings**. See [bank feeds](bank-feeds.md), [notifications](notifications.md) and [AI features](ai.md). Invite household members from **Settings → Members**; invitations are emailed through the SMTP settings in **Notifications**.

## Configuration

| Variable                                   | Purpose                                                                    |
| ------------------------------------------ | -------------------------------------------------------------------------- |
| `DOLPHINO_MODE`                            | `live` for real data, `demo` for fictional data. Default `demo`.           |
| `APP_ORIGIN`                               | The browser-visible origin. Live mode requires HTTPS.                      |
| `APP_SECRET` / `APP_SECRET_FILE`           | Key that encrypts saved credentials. At least 43 random characters.        |
| `DOLPHINO_BOOTSTRAP_TOKEN` / `_FILE`       | One-time proof for creating the first administrator.                       |
| `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER` | Database connection. All are required.                                     |
| `PGPASSWORD` / `PGPASSWORD_FILE`           | Database password.                                                         |
| `PGSSLMODE`, `PGSSLROOTCERT`               | Database TLS. See below.                                                   |
| `APP_BIND`                                 | Address Compose publishes port 3001 on. Default `127.0.0.1`.               |
| `TRUST_PROXY`                              | Proxy addresses allowed to set `X-Forwarded-For`. See below.               |
| `DOLPHINO_CURRENCY`, `DOLPHINO_TIMEZONE`   | Household currency and time zone. Defaults `AUD` and `Australia/Brisbane`. |
| `POSTGRES_VOLUME`                          | Bundled database only: the Docker volume that holds it.                    |

Every secret has a `_FILE` form that reads the value from a file. Leave the direct value empty when you use it. Bank feed, notification and AI credentials are not environment variables: they are entered in Settings and stored encrypted in PostgreSQL.

Keep a copy of `APP_SECRET` somewhere other than the database backups. Without it, saved credentials cannot be read and have to be entered again. Imported transactions are unaffected.

## Database

Give Dolphino its own database and role. Migrations run on startup.

A database is bound to the mode it first starts in. A demo database refuses to start in live mode, and the reverse. Use separate databases.

### TLS

Set `PGSSLMODE` for any database that is not on the same host:

- `verify-full` (recommended): encrypted, with the certificate checked against `PGHOST`. Publicly issued certificates work as they are. For a private CA, set `PGSSLROOTCERT` to the absolute path of its PEM file. In Docker, mount the file with the CA override: `docker compose -f compose.yaml -f compose.postgres-ca.yaml up -d --build`.
- `require`: encrypted, but the server is not authenticated. Startup logs a warning.
- `disable`: plain TCP. This is the default for `localhost`, and suits only a trusted network.

### Bundled PostgreSQL

To run PostgreSQL in Compose next to the app, create its volume once, set `POSTGRES_VOLUME=dolphino_postgres` in `.env` and leave the TLS settings empty:

```sh
docker volume create dolphino_postgres
docker compose -f compose.yaml -f compose.postgres.yaml up -d --build
```

Use the same `-f` flags for every later Compose command. The database is reachable only by the app.

## Reverse proxy

The app speaks plain HTTP on port 3001. Run the proxy on the same host, or set `APP_BIND` to an address the proxy can reach and firewall it. Docker-published ports bypass the host firewall's usual INPUT rules.

Set `TRUST_PROXY` to the address of the proxy that connects to the app, as the app sees it. Use exact IP addresses or narrow CIDR ranges, comma-separated. Loopback is always trusted. Only `X-Forwarded-For` is read, and only from trusted peers. The address it yields feeds the sign-in rate limits. With cloudflared in front of Caddy, trust Caddy's address, not cloudflared's.

## Backups

Back up the database with `pg_dump`, and keep `APP_SECRET` with your other secrets:

```sh
pg_dump -Fc --no-owner --no-acl -d dolphino > dolphino.dump
```

For the bundled database:

```sh
docker compose -f compose.yaml -f compose.postgres.yaml exec -T db pg_dump -U dolphino -d dolphino -Fc --no-owner --no-acl > dolphino.dump
```

To restore, stop the app, create an empty database, run `pg_restore --no-owner --no-acl -d <new database> dolphino.dump`, then point `PGDATABASE` at it and start the app. **Settings → Data** also exports transactions and reports as JSON. That export is not a full backup.

## Upgrading

Back up first. Then pull the new version and rebuild with the same Compose flags:

```sh
git pull
docker compose up -d --build
```

Migrations run automatically. Keep the same database and `APP_SECRET`.

## Rotating the encryption key

Stop the app, generate a new key, and re-encrypt the saved credentials with the old and new keys:

```sh
docker compose stop app
(umask 077; openssl rand -base64 32 > secrets/app_secret_new)
docker compose run --rm -e NEW_APP_SECRET_FILE=/run/secrets/app_secret_new app node scripts/rotate-secrets.mjs
```

The script reads the current key from `APP_SECRET_FILE` and changes nothing if any credential cannot be read. When it succeeds, point `APP_SECRET_FILE` at the new file and start the app. Keep the old key with backups taken before the rotation.

## Demo mode

`DOLPHINO_MODE=demo` serves fictional data with no sign-in and no external connections. Use a separate database, load the fixtures after the first start and keep it off public networks:

```sh
docker compose exec app npm run seed
```
