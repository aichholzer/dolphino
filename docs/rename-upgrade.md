# Upgrade Profe to dolphino without changing the database

The repository and product name are now **dolphino**: `https://github.com/aichholzer/dolphino`. Renaming a checkout must not create a fresh database or discard existing household users, financial history, grants, settings or encrypted credentials. Keep the current database, its database role/password, deployment mode and **the same APP_SECRET**. A product rename is not a credential rotation or a schema reset. Back up the database and APP_SECRET separately before upgrading; test restores into an isolated database.

An unfinished Telegram pairing started before the rename must be restarted: pairing nonces remain session-bound and deliberately fail closed across the cookie-handling transition. An already confirmed Telegram group target and its encrypted bot token remain configured; the rename does not re-pair a group, send a message, or change membership. Existing encrypted setting identifiers, ledger identities and internal lock/protocol names retain compatibility even where their historical spelling contains `profe`.

## Existing external PostgreSQL

Copy the existing private `.env` and secret files to the new checkout without committing them. Preserve the exact `DATABASE_URL` or `DATABASE_URL_FILE` and its mounted secret file. Database/user names such as `profe` are intentional compatibility identifiers and do not need renaming. Use only the default Compose file:

```sh
docker compose up -d --build
```

The default Compose does not add a database, replace the configured URL or fall back during an outage. Stop the previous app first; do not run two application workers against the same database during the upgrade. Update product environment-variable names according to the configuration compatibility documentation; do not change a live deployment into demo mode. The persisted deployment-mode lock remains in place.

## Existing bundled PostgreSQL: identify, preserve, then start

Previously, Compose derived the physical volume name from its project name and the `profe_postgres` volume key. The actual name may be `profe_profe_postgres`, but **do not guess**: a custom project name changes it. Moving into a directory named `dolphino` would otherwise produce another project and an empty database volume.

Before stopping the old deployment, run these read-only commands from its original checkout, with the same `-p`/project arguments originally used:

```sh
docker compose -f compose.yaml -f compose.postgres.yaml ps -q db
# Copy that database container ID into this read-only inspect command:
docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Type}} {{.Name}}{{end}}{{end}}' DATABASE_CONTAINER_ID
```

The result must identify the intended **volume** and its exact Docker name. If it shows a bind mount, an unexpected name, multiple database containers or an empty value, stop and identify the original storage configuration before continuing. Do not initialize a replacement database. Use the existing configuration to confirm the original database/user names and password; inspecting a volume name does not prove it contains the intended data.

The new bundled override requires all of these explicit `.env` values:

```dotenv
# Examples for an older default installation only; use your actual values.
POSTGRES_VOLUME=profe_profe_postgres
POSTGRES_DB=profe
POSTGRES_USER=profe
# Preserve the existing private POSTGRES_PASSWORD value, never this placeholder.
POSTGRES_PASSWORD=EXISTING_PRIVATE_PASSWORD
```

`POSTGRES_DB`, `POSTGRES_USER` and password are not renamed automatically. Use URL-safe names/passwords because the override constructs a PostgreSQL URL. Changing initialization variables does not rename an initialized PostgreSQL database/user or rotate its password. Keep PostgreSQL on the same major version used by the existing deployment; this rename keeps the bundled image at PostgreSQL 17.

After a verified backup, stop the old app and database using their old Compose project/configuration. **Never use `down -v` or `docker volume rm` for this upgrade.** Then inspect the preserved volume and validate the new configuration:

```sh
docker volume inspect YOUR_EXACT_EXISTING_VOLUME_NAME
# Outputs resolved configuration, including credentials: inspect privately, do not share/log it.
docker compose -f compose.yaml -f compose.postgres.yaml config --quiet
docker compose -f compose.yaml -f compose.postgres.yaml up -d --build
```

The new logical volume key `postgres_data` uses `external: true` and the exact required `POSTGRES_VOLUME` name. Docker Compose refuses a missing external volume instead of silently creating one. Directory/project names no longer influence that storage name. Do not run the old and new PostgreSQL containers simultaneously on the same data directory. The application still needs the same APP_SECRET to read encrypted settings.

Sign in and verify existing users, accounts, transaction counts, recent financial totals, budgets, labels, grants and Settings' configured-credential status before allowing ingestion. Keep the backup and old configuration until this check succeeds. Application migrations may update the existing database, so rollback means restoring a verified backup into an isolated replacement database and deliberately switching configuration—not blindly starting older code against a migrated schema.

## New installation with bundled PostgreSQL

For a genuinely new installation only, deliberately create a new volume:

```sh
docker volume create dolphino_postgres
```

Then configure `.env` explicitly:

```dotenv
POSTGRES_VOLUME=dolphino_postgres
POSTGRES_DB=dolphino
POSTGRES_USER=dolphino
# Generate privately with openssl rand -hex 32; no usable default is shipped.
POSTGRES_PASSWORD=YOUR_NEW_RANDOM_URL_SAFE_PASSWORD
```

Use a different volume/database for fictional demo versus live household data. Complete the normal HTTPS, APP_SECRET and first-administrator setup. Then:

```sh
docker compose -f compose.yaml -f compose.postgres.yaml config --quiet
docker compose -f compose.yaml -f compose.postgres.yaml up -d --build
```

Do not copy these new-install database/volume names over an existing installation. Required blank configuration and an external volume are intentional: they make database selection explicit, preserve existing data through a rename and prevent silent creation of a second database. No volumes were created or production databases touched during this change.

## Verification boundary

`backend/test/compose-upgrade.test.js` parses both Compose options with isolated synthetic `.env` files, verifies the external database URL/file remains unchanged, checks every required bundled variable, and verifies that different old/new project names resolve to the same explicitly selected existing volume and original database credentials. These are configuration regression tests; they do not start a PostgreSQL container or prove a volume's actual contents. Operators must inspect their existing volume and rehearse their own backup/restore. Full image runtime verification remains separately documented in the main verification notes.

## Configuration, sessions and persisted protocol identifiers

New configuration uses `DOLPHINO_MODE`, `DOLPHINO_CURRENCY`, `DOLPHINO_TIMEZONE`, `DOLPHINO_BOOTSTRAP_TOKEN` and their `_FILE` equivalents. Existing `PROFE_*` aliases remain accepted; supplying conflicting old/new values fails closed instead of selecting a different mode or key. `DOLPHINO_RESTORE_CONFIRM` replaces `PROFE_RESTORE_CONFIRM` with the same conflict rule. Database URLs and APP_SECRET are unchanged. Redbark and classification integration values are now configured only in administrator Settings; former integration environment values are ignored. Existing environment-only users must explicitly re-enter them after upgrade, as described in the [database integration upgrade checklist](database-integration-upgrade.md).

New logins issue `dolphino_session`; old `profe_session` cookies continue resolving the same hashed PostgreSQL session records until their normal expiration. If both names exist the new name takes precedence, and a malformed new cookie never falls back to the old one. Logout and password changes expire both cookie names. User passwords, grants, invitation hashes and database-mode bindings are unchanged.

The strings `profe/settings/key/v1`, `profe/settings/key/v2/AES-256-GCM credential encryption` and `profe-credential` deliberately remain the versioned encryption protocol domains, including for newly written ciphertext. Renaming these would invalidate saved credentials. Ledger/classification advisory-lock namespaces and stable email Message-IDs also retain their historical spelling to coordinate existing work and preserve retry identities. These are internal compatibility identifiers, not display branding. No credential re-encryption or master-key change is necessary.

The local feature branch remains `feat/profe-mvp` to retain delivery continuity; the canonical remote is the verified renamed repository. Historical commits and stored audit records are unchanged.
