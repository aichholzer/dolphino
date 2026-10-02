# Upgrade dolphino safely

This release consolidates plain JavaScript modules under `.mjs`, simplifies backend ownership, and removes transitional product identifiers. It deliberately retires credential envelope versions 1 and 2, old branded environment aliases and old session-cookie names. **Read the credential recovery limitations below before upgrading.** There is no automatic re-encryption or database reset.

Keep the existing database, its role/password, deployment mode and **the current APP_SECRET**. Financial history, imported evidence, corrections, users, grants, sessions, jobs and saved ciphertext remain stored. Retained ciphertext is not necessarily readable: the current vault accepts only Dolphino version 3 envelopes. The old master key alone cannot recover a retired envelope in this release. Only a deliberately fresh, separate installation should start with a new database or newly generated master key.

## Before changing the application

1. Record the installed application version, non-secret deployment configuration and exact PostgreSQL identity. Back up PostgreSQL and protect a separate copy of the matching APP_SECRET. Rehearse restoration into an isolated empty database before relying on that backup.
2. Confirm that you can deliberately replace or clear each saved integration credential. Pay particular attention to SimpleFIN's historical account-mapping limitation below. Do not proceed assuming a key rotation will convert retired ciphertext.
3. **Stop every prior application and background-worker process**, including replicas and separately launched workers, before starting the new release. Advisory-lock namespaces have changed; mixed releases cannot safely coordinate. Do not run two PostgreSQL containers against the same data directory.
4. Review pending invitation and notification deliveries. SMTP Message-ID namespaces have changed, so a retried pending delivery may use a different identity. Delivery was never exactly once; reconcile uncertain sends before enabling workers.
5. Update explicit configuration and startup paths. Preserve the current database/volume and APP_SECRET. Never seed a live database, clear its schema, delete its volume or switch its mode to resolve an upgrade problem.

## Existing external PostgreSQL

Copy the private `.env` and secret files to the new checkout without committing them. If the installation still uses `DATABASE_URL`/`DATABASE_URL_FILE`, move the exact server, database, user and decoded password into `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER` and `PGPASSWORD`/`PGPASSWORD_FILE`. Remove both retired URL variables: startup rejects them even when individual settings are supplied. Database and role names do not need to match the product name and must not be renamed as part of this cleanup. Never put URLs containing passwords, secret values or connection dumps into chat or logs.

Choose `PGSSLMODE` explicitly for off-host PostgreSQL. Prefer `verify-full` with the correct certificate hostname and trusted CA; `require` provides encryption without authenticating the server, and `disable` is deliberate plain TCP. No connection failure triggers a weaker mode or another database. Preserve any necessary custom CA using the [TLS deployment instructions](deployment.md#postgresql-tls).

After stopping all old processes and completing the backup and recovery review, validate and start the external-database deployment:

```sh
docker compose config --quiet
docker compose up -d --build
```

Add the documented `compose.postgres-ca.yaml` override only when a custom host CA file is needed. The default Compose file does not create a database and is never an outage fallback.

## Existing bundled PostgreSQL

Identify the actual running database container from the old deployment before changing its directory or Compose project name:

```sh
docker compose -f compose.yaml -f compose.postgres.yaml ps -q db
docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Type}} {{.Name}}{{end}}{{end}}' DATABASE_CONTAINER_ID
```

Substitute the verified container ID. Record the exact named-volume identity; **do not guess it from the directory or project name**. If the existing deployment uses a bind mount rather than a named volume, preserve that mount through an explicitly reviewed deployment configuration instead of treating its path as a Docker volume name.

Set `POSTGRES_VOLUME` to the exact existing named volume. Keep the actual database, role and password in `PGDATABASE`, `PGUSER` and `PGPASSWORD`/`PGPASSWORD_FILE`. Map any old PostgreSQL-container initialization values to these fields without changing their values. Remove retired URL variables, including placeholders that earlier Compose configurations overrode. Leave `PGSSLMODE` and `PGSSLROOTCERT` unset only when intentionally using the bundled plain-TCP Docker network.

For a bundled password file, use `./postgres-secrets/password` with `PGPASSWORD_FILE=/run/postgres-secrets/password` and an empty direct password. Do not expose the app's APP_SECRET/bootstrap files to the database container. Use a single-line database password with at most one final LF/CRLF; see [bundled PostgreSQL](deployment.md#explicit-alternative-bundled-postgresql).

The override keeps the bundled image on PostgreSQL 17. Verify that this matches the existing data directory's major version; a PostgreSQL major-version upgrade is a separate operation. Changing initialization variables does not rename an initialized database/role or rotate its password.

After stopping the old application/workers and database container, validate and start the new deployment:

```sh
docker compose -f compose.yaml -f compose.postgres.yaml config --quiet
docker compose -f compose.yaml -f compose.postgres.yaml up -d --build
```

The `postgres_data` logical volume is external and requires the exact `POSTGRES_VOLUME`. A missing volume makes Compose fail rather than silently creating an empty replacement. Do not create a volume for an upgrade and do not run `docker compose down -v` as an upgrade step. Only a genuinely new installation should follow the [new bundled installation instructions](deployment.md#explicit-alternative-bundled-postgresql).

## Environment, sessions and module paths

Use `DOLPHINO_MODE`, `DOLPHINO_CURRENCY`, `DOLPHINO_TIMEZONE` and `DOLPHINO_BOOTSTRAP_TOKEN`, or their `_FILE` forms. Conflicting nonempty direct/file values fail closed. Old branded aliases are no longer read: explicitly transfer the intended values before starting, particularly `DOLPHINO_MODE=live`. Restore confirmation uses `DOLPHINO_RESTORE_CONFIRM` matching the target `PGDATABASE`; there is no old-name fallback. APP_SECRET and individual PostgreSQL settings retain their separate names. Integration configuration comes only from administrator Settings, never former integration environment variables.

Only the `dolphino_session` cookie is accepted. Users with a prior cookie name must sign in again. Password hashes, grants, database session records and mode bindings are not reset. Canonically named, otherwise valid sessions remain usable.

`backend/src/` contains only the `app.mjs` and `server.mjs` composition roots. Domain services live in `backend/src/lib/`; maintenance/demo entrypoints are `backend/src/utils/migrate.mjs`, `seed.mjs` and `demo.mjs`. HTTP and route modules remain in `http/` and `routes/`. Plain-JavaScript source, tests, scripts and configuration use `.mjs`; JSX stays `.jsx`. Update any external service-manager commands or local automation that invoke old paths. Package scripts remain the preferred entrypoints. The 13 substantive SQL migrations are retained; this is not a new financial schema or a migration squash.

## Recover saved integrations explicitly

Version 1/2 credentials remain stored but fail closed. Blank secret fields preserve that ciphertext; saving a form alone does not repair it. No retired envelope is decrypted, silently cleared, converted or replaced by environment credentials. Keep the current APP_SECRET for readable version 3 rows and matching backups. Recover each affected integration through its normal explicit controls:

- **Classification and assistant:** enter replacement credentials for every required provider field, or explicitly clear unused credentials. Empty/omitted values retain existing ciphertext. Enabling with unreadable required credentials fails and rolls back the save; disabling alone does not convert them. Review provider/model, sharing consent, automation and spending limits before enabling
- **Redbark:** replace the API key, then test the saved connection. An API-key replacement invalidates the old webhook binding. Also supply the matching signing secret or explicitly register/recover the appropriate destination; replacing only the API key does not restore webhook verification. Retained jobs from an unproven/different credential account stay paused. Verify a synthetic receipt only when you intend to contact the provider
- **SMTP:** replace the stored SMTP URL or explicitly clear it. Review sender, recipients, audience consent and queued deliveries before enabling. A configured secret may still be unavailable; notification settings expose `credentialsAvailable` and a warning for this state
- **Telegram:** replace the bot token or explicitly clear it. Either removes the local pairing; explicitly pair and confirm the intended private group again before enabling. Saving the old group selection alone cannot repair the credential
- **SimpleFIN:** an existing configured but unreadable Access URL requires **Disconnect locally** before a new one-use setup token can be claimed. This preserves financial history and reserved mappings. The new connection gets a new source identity. **Historical mapped accounts cannot be automatically relinked or resumed under that new source.** Do not disconnect assuming a new token will fully restore mapped imports; source migration needs a separately designed, reviewable reconciliation workflow. Never wipe the database to work around this limitation

Imported financial data and manual work remain accessible while credential-dependent operations fail closed. Review the [database integration checklist](database-integration-upgrade.md), [encrypted settings](settings-security.md), and [SimpleFIN limitations](simplefin.md) before restoring external access.

## Rotation, verification and rollback

Offline key rotation decrypts **every** stored credential in one transaction. Any retired or otherwise unreadable row causes complete rollback; it is not a legacy-format recovery tool. Replace or explicitly clear all such credentials first, including disabled providers, before following the [rotation procedure](settings-security.md#explicit-offline-key-rotation). There is no automatic re-encryption or dual-key deployment mode.

Before normal use, inspect administrator access, household grants, account counts, financial reports, corrections, integration status and pending jobs. A Compose configuration test proves storage selection, not the contents of an actual volume or a running-container upgrade. Use the [current cleanup verification record](module-cleanup-verification.md) for the checks actually run; older records describe earlier milestones.

If rollback is necessary, stop every new process first and restore a matching application version, pre-upgrade PostgreSQL backup and protected matching key into an isolated empty target. Review totals, grants, settings and queued deliveries with external provider access blocked before deliberately switching the deployment to the restored target. A pre-upgrade backup requires a compatible application version to read its retired credential formats. Never restore over a working database as the first rehearsal, and never run old and new workers together. See [backup and restore](deployment.md#export-backup-and-restore).
