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

`npm run check` runs lint, the format check, the build and the tests in one command. `backend/test/security-adversarial.test.mjs` checks the headers on the built `index.html` and renders hostile content in Chromium. Build before `npm test`, and set `CHROMIUM_PATH` when Chromium is not at `/usr/bin/chromium`.

`backend/test/server-startup.test.mjs` and `backend/test/maintenance-scripts.test.mjs` run `backend/src/server.mjs` and the two operator scripts as child processes against the test database, each pinned to its own schema through `PGOPTIONS`. Their coverage counts toward the report.

The React hooks are tested in Node. `frontend/test/*-hooks.test.mjs` import `react-harness.mjs` first: it installs a jsdom window as the browser globals, compiles extensionless `.jsx` imports with esbuild, and fails the file on any React or jsdom console error, such as an update outside `act()`. Load React DOM and the code under test with `await import()` after the harness.

## Browser checks

Run `npm run build` first. Each `npm run test:browser:*` script drives Chromium against the compiled frontend and honours `CHROMIUM_PATH`.

- Most start their own server, with synthetic fixtures or the test database.
- `test:browser`, `test:browser:theme`, `test:browser:auth` and `frontend/test/category-repair.browser.mjs` drive the running fictional demo at `http://localhost:3001`. Set `DOLPHINO_TEST_URL` for another address.
- `test:browser:integration-settings`, `test:browser:bedrock-models`, `test:browser:simplefin`, `test:browser:members` and `test:browser:manual` need the test database.
- Scripts that save screenshots write to the git-ignored `artifacts/` folder, or to `DOLPHINO_SCREENSHOT_DIR` when set.

`npm run test:browser:all` runs every check in turn. It seeds a fictional demo on its own schema of the test database, starts a demo server on a free port for the demo checks, and prints each failing script's output. Pass names to run a subset: `node frontend/test/browser-suite.mjs auth theme`.

Browser checks launch Chromium through `frontend/test/browser.mjs`. Import `chromium` from there in new checks.

## Continuous integration

`.github/workflows/ci.yml` runs on every push to `main` and every pull request: `npm ci`, lint, the format check, the build, `npm run coverage` and `npm run coverage:browser` against a PostgreSQL 17 service container and the runner's Google Chrome. The coverage summary goes to the job summary, and the HTML report is uploaded as the `coverage` artifact.

## Coverage

```sh
npm run coverage
npm run coverage:browser
```

`npm run coverage` runs the unit suite under [c8](https://github.com/bcoe/c8). `npm run coverage:browser` builds the frontend with `vite build --mode coverage`, runs every browser check under c8, adds their results to the same report, and rebuilds the production bundle. Run it after `npm run coverage` for the combined figures.

Both need the test database, and the browser run needs Chromium. Reports land in the git-ignored `coverage/` folder: a text table, `coverage/index.html` and `coverage/lcov.info`. `.c8rc.json` reports every file in `backend/src`, `frontend/src` and `scripts`, including files no test loads.

- Child processes inherit `NODE_V8_COVERAGE`. The servers and scripts the tests start count toward the report.
- In the browser, `frontend/test/browser.mjs` records Chromium's JS coverage per page. The coverage build is unminified and carries inline source maps with absolute paths, which map each bundle back to `frontend/src`.
- Tailwind reads only `frontend/index.html` and `frontend/src`. The coverage settings, tests and docs never change the production CSS.

## Database outage tests

Two tests stop and restart PostgreSQL to prove that work fails closed and resumes after recovery. They are skipped unless `DOLPHINO_DB_SHUTDOWN_TEST=1`. They also require a test-owned server: `DOLPHINO_TEST_PG_ISOLATED=1`, `DOLPHINO_TEST_PG_CTL` (the `pg_ctl` binary), `DOLPHINO_TEST_PG_DATA_DIR` and `PGPORT`.

## Restore rehearsal

`node backend/test/restore-rehearsal.mjs` seeds a fictional ledger, backs it up with `scripts/backup.sh`, restores it into a fresh database with `scripts/restore.sh`, and compares every table and both financial reports. It needs `pg_dump`, `pg_restore` and `psql` on `PATH` and a role with `CREATEDB`. It reads the `PG*` variables, or `REHEARSAL_ADMIN_URL` for a separate administrative connection, and refuses any host other than the local machine. Its databases and dump are removed afterwards.
