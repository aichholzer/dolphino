# Testing

Every check uses synthetic data. Never point a test, seed or restore rehearsal at a live household database.

## Test database

PostgreSQL-dependent tests read the standard `PG*` variables (`PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`, `PGSSLMODE`) or `TEST_DATABASE_URL`. Without either, those tests are skipped. Each test creates and drops its own schema. A disposable container is enough:

```sh
docker run -d --name dolphino-test-pg -e POSTGRES_USER=dolphino_test -e POSTGRES_PASSWORD=testonly \
  -e POSTGRES_DB=dolphino_test -p 127.0.0.1:55433:5432 postgres:17-alpine
export PGHOST=127.0.0.1 PGPORT=55433 PGDATABASE=dolphino_test PGUSER=dolphino_test PGPASSWORD=testonly PGSSLMODE=disable
```

## Checks

```sh
npm run lint
npm run format:check
npm test
npm run build
npm run check:theme
```

`npm run check` runs lint, the format check, the tests and the build in one command. `backend/test/security-adversarial.test.mjs` renders hostile content in Chromium; set `CHROMIUM_PATH` when Chromium is not at `/usr/bin/chromium`.

## Browser checks

Run `npm run build` first. Each `npm run test:browser:*` script drives Chromium against the compiled frontend and honours `CHROMIUM_PATH`.

- Most start their own server, with synthetic fixtures or the test database.
- `test:browser`, `test:browser:theme`, `test:browser:auth` and `frontend/test/category-repair.browser.mjs` drive the running fictional demo at `http://localhost:3001`. Set `DOLPHINO_TEST_URL` for another address.
- `test:browser:integration-settings`, `test:browser:bedrock-models` and `test:browser:simplefin` need the test database.
- Scripts that save screenshots write to the git-ignored `artifacts/` folder, or to `DOLPHINO_SCREENSHOT_DIR` when set.

## Database outage tests

Two tests stop and restart PostgreSQL to prove that work fails closed and resumes after recovery. They are skipped unless `DOLPHINO_DB_SHUTDOWN_TEST=1`. They also require a test-owned server: `DOLPHINO_TEST_PG_ISOLATED=1`, `DOLPHINO_TEST_PG_CTL` (the `pg_ctl` binary), `DOLPHINO_TEST_PG_DATA_DIR` and `PGPORT`.

## Restore rehearsal

`node backend/test/restore-rehearsal.mjs` seeds a fictional ledger, backs it up with `scripts/backup.sh`, restores it into a fresh database with `scripts/restore.sh`, and compares every table and both financial reports. It needs `pg_dump`, `pg_restore` and `psql` on `PATH` and a role with `CREATEDB`. It reads the `PG*` variables, or `REHEARSAL_ADMIN_URL` for a separate administrative connection, and refuses any host other than the local machine. Its databases and dump are removed afterwards.
