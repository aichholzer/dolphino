# Code organization and maintenance

Dolphino remains a plain-JavaScript Rayo API, a React frontend and a PostgreSQL-backed accounting engine. The module boundaries follow responsibilities rather than a file-size target. This cleanup does not change HTTP URLs, response shapes, database migrations, provider protocols or exact-money accounting.

## Backend

- `backend/src/postgres-config.js` validates individual PostgreSQL identity, secret-file and explicit TLS settings for every application/maintenance entry point. Its options are passed directly to node-postgres, with no connection-string parser or fallback.
- `backend/src/http/client-ip.mjs` owns bounded trusted-proxy IP resolution; the HTTP boundary and authentication limiter use the same policy.
- `backend/src/server.js` is the process composition root: construct services, initialize schema, start workers, and coordinate shutdown.
- `backend/src/app.js` is the HTTP composition root: construct the shared guards and register domain routes. It must not contain domain handlers or start background work.
- `backend/src/routes/` groups HTTP schemas and handlers by domain: auth, users, accounts, transactions, budgets, reports, reviews, rules, settings, integrations, notifications and the read-only assistant.
- `backend/src/http/` owns the bounded body parser, JSON responses, security headers, access/origin/error boundary, sensitive-action limiter and static frontend serving.
- `backend/src/routes/finance-queries.mjs` owns HTTP report/filter adaptation; `finance-schemas.mjs` contains the small shared finance request primitives.
- `backend/src/smtp-transport.js` owns shared invitation/notification email validation and delivery; SMTP DNS pinning, TLS policy and error redaction remain together.
- The accounting engine, access facade, persistence store and provider/worker services stay independent of HTTP routing. Their transaction, lock, deduplication and credential-fencing behavior is preserved.

### Adding a route safely

Register every API route through the shared registrar. The default policy is administrator-only. Explicit `access` values are `public`, `member` and `financial`; unknown policies throw during registration. Financial handlers receive a request-scoped access facade and fail closed if it is absent. Do not pass the raw store to a financial handler as a fallback.

Public authentication writes still require the exact configured Origin. The signed Redbark webhook is the only current Origin exception and receives the original bounded bytes. The assistant re-reads the session and permissions on each context request and exposes only frozen read capabilities. Classification suggestions remain administrator-only even though their URL begins with `/api/transactions/`.

Keep the per-app sensitive-action guard shared across domain modules. Moving a handler must not create an independent rate limiter or enable credential storage/external calls in demo mode. Registration must remain lazy: construct handlers without eagerly using optional service dependencies.

When adding or intentionally changing an endpoint, review the policy fixture in `backend/test/fixtures/route-contract.json` and the database-free HTTP boundary tests. These tests exercise both each module's declaration and every mounted endpoint, so an omitted registration is detected.

## Frontend

- `frontend/src/main.jsx` mounts the application and imports its stylesheet.
- `frontend/src/app.jsx` controls authentication and the principal-boundary lifecycle.
- `frontend/src/financial-workspace.jsx` coordinates the active page, reporting controls, cross-page drilldowns and editors.
- `frontend/src/components/` contains the shared app shell, page heading, empty state, primitive controls and independently scoped settings/assistant components.
- `frontend/src/features/` contains domain pages and their editors. Exact transaction and budget validation lives beside the corresponding feature, in plain-JavaScript model helpers.
- `frontend/src/hooks/` owns page-data fetching and transaction filters. `frontend/src/lib/` contains the API client, report query construction and server-issued UI capability interpretation.
- `shared/money.js` remains the single exact-money utility, re-exported by the frontend. Display and editor code must not convert persisted minor units through floating-point arithmetic.

Financial state belongs to a workspace keyed by the authenticated principal and permissions. Logout, activation, a different user or changed grants dispose of cached reports, accounts, dialogs and other workspace state. Responses from an old workspace are ignored. A failed initial load displays an error/empty state rather than invented zero totals or another user's cached data. Server-side grants remain authoritative; frontend capability checks are only a presentation layer.

Do not persist application data or credentials in `localStorage`, `sessionStorage`, IndexedDB, Cache Storage or service workers. Reports, editors, settings input and assistant conversations use React memory only. Authentication remains a server-side session carried by an HttpOnly cookie; frontend JavaScript must not read or construct session cookies. Browser regression checks instrument storage APIs so attempted use fails even if application code catches the exception.

## Review boundaries

The persistence store and provider job services deliberately retain their cohesive transaction/state-machine responsibilities. Splitting their locked operations across superficial repositories or mixins would obscure atomicity without improving ownership. Keep migrations immutable, provider normalization separate from ingestion, and test fakes at the transport boundary. Prefer small pure helpers when they have a distinct reusable purpose; do not create a general framework to move a few lines.

## Formatting and checks

ESLint's recommended rules apply to all repository JavaScript, JSX and MJS, with scoped browser/Node globals, required braces and unused-variable detection. Prettier covers supported source, tests, configuration and documentation formats, excluding generated output and the generated npm lockfile.

```sh
npm run lint
npm run lint:fix
npm run format
npm run format:check
npm run check
```

`npm run check` runs lint, formatting verification, tests and the frontend build. PostgreSQL-dependent checks require a disposable test database; database outage tests additionally require the explicit isolated-server opt-in documented in the verification record. Build the current frontend before browser checks. Never use a live household database for seeds, destructive outage tests or restore rehearsals.
