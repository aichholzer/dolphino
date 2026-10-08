# Development

Dolphino is plain JavaScript: a [Rayo](https://github.com/GetRayo/rayo.js) API in `backend/`, a React and Vite app in `frontend/`, and PostgreSQL. It needs Node.js 24 or later.

## Layout

- `backend/src/server.mjs` starts the process: services, migrations, workers and shutdown. `app.mjs` registers the HTTP routes.
- `backend/src/routes/` holds the HTTP handlers by domain, `backend/src/http/` the shared request boundary, and `backend/src/lib/` everything else.
- `backend/migrations/` holds the SQL migrations. Add new files; never edit old ones.
- `frontend/src/features/` holds the pages and their editors, `components/` the shared UI, `hooks/` and `lib/` the data fetching and helpers.
- `shared/money.mjs` holds exact money arithmetic. Amounts are integer minor units, kept as strings or `BigInt`, never floating point.
- `scripts/rotate-secrets.mjs` is the operator's key rotation tool.

Every API route goes through the registrar in `backend/src/http/router.mjs`, which requires an administrator unless the route declares `access: 'public'`, `'member'` or `'financial'`. When you add or change an endpoint, update `backend/test/fixtures/route-contract.json`.

The frontend keeps all data in memory. Do not use `localStorage`, `sessionStorage`, IndexedDB or service workers; the browser checks fail if anything does.

## Running it

Start the backend in demo mode as the README describes, then run Vite in a second terminal with `APP_ORIGIN=http://localhost:5173`:

```sh
npm run dev --workspace frontend
```

## Checks

```sh
npm run check
```

That runs ESLint, the Prettier check, the build and the tests. `npm run lint:fix` and `npm run format` fix most findings.

## Test database

Tests that need PostgreSQL skip until the `PG*` variables (or `TEST_DATABASE_URL`) point at a disposable database. Each test creates and drops its own schema. Never point tests at a database holding real data.

```sh
docker run -d --name dolphino-test-pg -e POSTGRES_USER=dolphino_test -e POSTGRES_PASSWORD=testonly \
  -e POSTGRES_DB=dolphino_test -p 127.0.0.1:55433:5432 postgres:17-alpine
export PGHOST=127.0.0.1 PGPORT=55433 PGDATABASE=dolphino_test PGUSER=dolphino_test PGPASSWORD=testonly PGSSLMODE=disable
```

Some tests drive Chromium. Set `CHROMIUM_PATH` when it is not at `/usr/bin/chromium`.

React hooks are tested in Node: `frontend/test/*-hooks.test.mjs` import `react-harness.mjs` first, then load the code under test with `await import()`.

## Browser checks

Each `frontend/test/*.browser.mjs` drives Chromium against the built app. Build first, then run them all with the test database configured:

```sh
npm run build
npm run test:browser:all
```

The runner seeds a fictional demo for the checks that need one. Pass script names to run a subset: `node frontend/test/browser-suite.mjs members theme`. New checks import `chromium` from `frontend/test/browser.mjs`. Screenshots go to the git-ignored `artifacts/` folder.

## Coverage

```sh
npm run coverage
npm run coverage:browser
npm run coverage:check
```

The first runs the unit tests under c8, the second adds every browser check, and the third fails below 90% of lines, statements and functions or 88% of branches. Reports are written to `coverage/`, including `coverage/index.html`.

## CI

`.github/workflows/ci.yml` runs on every push to `main` and every pull request: lint, the format check, the build, both coverage runs and the coverage floor, against PostgreSQL 17 and Chrome.
