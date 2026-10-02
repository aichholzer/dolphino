# Code organization and maintenance

Administrator Settings is organized into RedBark, Categories, Members, Notifications, Data (SimpleFIN, import health/history and export), and AI features. AI features has one shared connection and separate feature controls; [shared AI settings](ai-settings.md) documents storage, migration and the API contract.

Dolphino remains a plain-JavaScript Rayo API, a React frontend and a PostgreSQL-backed accounting engine. The module boundaries follow responsibilities rather than a file-size target. Module moves preserve HTTP URLs, financial calculations and the existing SQL migrations. The deliberate environment, cookie, credential-envelope and internal-namespace changes are documented separately in [upgrade and recovery guidance](upgrading.md); notification credential availability is exposed explicitly.

## Module naming and ownership

All repository plain JavaScript uses the explicit `.mjs` extension, including frontend helpers, shared code, tests, scripts and configuration; files containing JSX stay `.jsx`. Keep relative import extensions explicit and update package scripts, Docker paths and browser/test entrypoints when moving a module. Do not add duplicate wrapper modules solely to preserve retired paths.

## Backend

`backend/src/` contains only the HTTP and process composition roots, `app.mjs` and `server.mjs`. Reusable non-HTTP services belong in `backend/src/lib/`. Operational/demo entrypoints belong in `backend/src/utils/`: `migrate.mjs`, `seed.mjs` and `demo.mjs`. The 13 substantive SQL files in `backend/migrations/` remain the schema history; they are not a squash/reset target.

- `backend/src/lib/postgres-config.mjs` validates individual PostgreSQL identity, secret-file and explicit TLS settings for every application/maintenance entry point. Its options are passed directly to node-postgres, with no connection-string parser or fallback.
- `backend/src/http/client-ip.mjs` owns bounded trusted-proxy IP resolution; the HTTP boundary and authentication limiter use the same policy.
- `backend/src/server.mjs` is the process composition root: construct services, initialize schema, start workers, and coordinate shutdown. For AI, construct the credential vault with `createSettingsStore`, construct `createAiSettings({ pool, settings: vault, appSecret })`, and await `ai.init()`. Pass `{ ...vault, ...ai.classification }` to classification consumers, `ai.assistant` to assistant consumers, and `aiSettings: ai` to `createApp`; production runtime must not independently read the old provider profiles.
- `backend/src/lib/ai-settings.mjs` owns the shared provider/credential identity, transactional legacy-profile resolution, feature projections and revision fencing. It reads metadata and ciphertext in one MVCC statement, and serializes writes through the vault/classification advisory lock. Shared changes cannot race a feature save or application of a stale classification result.
- `backend/src/app.mjs` is the HTTP composition root: construct the shared guards and register domain routes. It must not contain domain handlers or start background work.
- `backend/src/routes/` groups HTTP schemas and handlers by domain: auth, users, accounts, transactions, budgets, reports, reviews, rules, settings, integrations, notifications and the read-only assistant.
- `backend/src/http/` owns the bounded body parser, JSON responses, security headers, access/origin/error boundary, sensitive-action limiter and static frontend serving.
- `backend/src/routes/finance-queries.mjs` owns HTTP report/filter adaptation; `finance-schemas.mjs` contains the small shared finance request primitives.
- `backend/src/lib/smtp-transport.mjs` owns shared invitation/notification email validation and delivery; SMTP DNS pinning, TLS policy and error redaction remain together.
- The accounting engine, access facade, persistence store and provider/worker services stay independent of HTTP routing. Their transaction, deduplication and credential-fencing boundaries remain cohesive. Current lock namespaces require every prior worker to stop before an upgrade; mixed releases cannot safely coordinate.

### Adding a route safely

Register every API route through the shared registrar. The default policy is administrator-only. Explicit `access` values are `public`, `member` and `financial`; unknown policies throw during registration. Financial handlers receive a request-scoped access facade and fail closed if it is absent. Do not pass the raw store to a financial handler as a fallback.

Public authentication writes still require the exact configured Origin. The signed Redbark webhook is the only current Origin exception and receives the original bounded bytes. The assistant re-reads the session and permissions on each context request and exposes only frozen read capabilities. Classification suggestions remain administrator-only even though their URL begins with `/api/transactions/`.

Keep the per-app sensitive-action guard shared across domain modules. Moving a handler must not create an independent rate limiter or enable credential storage/external calls in demo mode. Registration must remain lazy: construct handlers without eagerly using optional service dependencies.

When adding or intentionally changing an endpoint, review the policy fixture in `backend/test/fixtures/route-contract.json` and the database-free HTTP boundary tests. These tests exercise both each module's declaration and every mounted endpoint, so an omitted registration is detected.

## Frontend

- `frontend/src/main.jsx` mounts the application and imports its stylesheet.
- `frontend/src/app.jsx` controls authentication and the principal-boundary lifecycle.
- `frontend/src/financial-workspace.jsx` coordinates the active page, reporting controls, cross-page drilldowns and editors.
- `frontend/src/components/` contains the shared app shell, page heading, empty state, primitive controls and focused settings/assistant components. The AI settings coordinator owns the saved shared connection and one Bedrock catalog; feature editors receive that shared state while owning only models, limits and enablement/consent.
- `frontend/src/features/` contains domain pages and their editors. Exact transaction and budget validation lives beside the corresponding feature, in plain-JavaScript model helpers.
- `frontend/src/hooks/` owns page-data fetching and transaction filters. `frontend/src/lib/` contains the API client, report query construction and server-issued UI capability interpretation.
- `shared/money.mjs` remains the single exact-money utility, re-exported by the frontend. Display and editor code must not convert persisted minor units through floating-point arithmetic.

Financial state belongs to a workspace keyed by the authenticated principal and permissions. Logout, activation, a different user or changed grants dispose of cached reports, accounts, dialogs and other workspace state. Responses from an old workspace are ignored. A failed initial load displays an error/empty state rather than invented zero totals or another user's cached data. Server-side grants remain authoritative; frontend capability checks are only a presentation layer.

Do not persist application data or credentials in `localStorage`, `sessionStorage`, IndexedDB, Cache Storage or service workers. Reports, editors, settings input and assistant conversations use React memory only. Authentication remains a server-side session carried by an HttpOnly cookie; frontend JavaScript must not read or construct session cookies. Browser regression checks instrument storage APIs so attempted use fails even if application code catches the exception.

## Review boundaries

The persistence store and provider job services deliberately retain their cohesive transaction/state-machine responsibilities. Splitting their locked operations across superficial repositories or mixins would obscure atomicity without improving ownership. Keep migrations immutable, provider normalization separate from ingestion, and test fakes at the transport boundary. Prefer small pure helpers when they have a distinct reusable purpose; do not create a general framework to move a few lines.

## Formatting and checks

ESLint 10's recommended rules apply to repository `.mjs` and `.jsx` with scoped browser/Node globals, required braces and unused-variable detection. Intentionally unused arguments may start with `_`; object-rest omissions remain allowed. `@stylistic/eslint-plugin` 5.10.0 adds only `padding-line-between-statements` at error severity: always require a blank line after a function declaration, an export statement or a multiline block-like statement when followed by another statement. No broad stylistic preset is enabled.

Prettier stays responsible for 120-column wrapping, two-space indentation, single quotes, semicolons, no trailing commas, bracket spacing and parentheses around every arrow-function parameter. It covers supported source, tests, configuration and documentation formats, excluding generated output and the generated npm lockfile. The blank-line lint rule complements that unchanged configuration.

```sh
npm run lint
npm run lint:fix
npm run format
npm run format:check
npm run check
```

`npm run check` runs lint, formatting verification, tests and the frontend build. PostgreSQL-dependent checks require a disposable test database; database outage tests additionally require the explicit isolated-server opt-in documented in the verification record. Build the current frontend before browser checks. Never use a live household database for seeds, destructive outage tests or restore rehearsals.
