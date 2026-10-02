# Historical maintainability verification — 1 October 2026

**Historical scope:** this record predates the shared-AI settings change. Descriptions of independent classification/assistant credentials and per-form discovery describe that earlier implementation, not current behavior. Current production uses one shared connection, separate feature controls and one model catalog; see [shared AI settings](ai-settings.md) and [its verification record](shared-ai-settings-verification.md). The original dated evidence and counts below are preserved, not claimed as new runs.

This is the earlier route/frontend refactor and PostgreSQL/proxy milestone, recorded before the subsequent `.mjs`/backend-layout and version 3 credential cleanup. Its test counts and compatibility statements describe that earlier state, not a rerun of the current release. See [current cleanup verification](module-cleanup-verification.md) and [upgrade boundaries](upgrading.md).

All data, credentials, provider responses and notification destinations used here were synthetic. PostgreSQL 17.6 ran in a fresh disposable local cluster. No production deployment, real financial provider connection, model call, message delivery or live household data was used.

## Changes

- The 925-line API file is now a 79-line composition root. Domain route modules own request schemas and handlers; one HTTP boundary owns authentication, authorization, Origin checks, headers, bounded bodies and safe errors.
- The 2,159-line frontend entry is now a 10-line mount. Authentication, the financial workspace, shared shell, domain pages/editors, data/filter hooks and pure capability/query/money helpers have distinct responsibilities.
- SMTP delivery is a shared transport used by invitations and notifications, preserving its existing public exports and security controls.
- ESLint 10, `@eslint/js` recommended rules and appropriate Node/browser globals replace the syntax-only check. Required braces and the requested unused-variable policy are enforced. Prettier uses the exact requested 120-column, two-space, single-quote, semicolon, no-trailing-comma configuration across supported source, test, configuration and documentation files.
- No financial/credential/assistant data is stored in browser persistent application storage. Existing HttpOnly session-cookie authentication is retained.

See [architecture and maintenance guidance](architecture.md) for module ownership and safe extension points.

## Verified security corrections

Review reproduced a pre-existing browser-memory bug: after switching from an administrator to another user, a failed account reload could show the previous user's cached account data. Financial workspaces are now disposed at authentication/principal/permission boundaries. Pending requests cannot repopulate a new workspace; previous editor state and assistant state are discarded. The same-principal logout/login case is covered too.

Review also reproduced stale callbacks after navigation. Delayed review mutations and settings saves now refresh the current report instead of loading a previous page or assigning settings data to an Accounts view. Assistant requests are aborted and their results invalidated when the workspace unmounts.

Route-policy typos fail during registration. Financial handlers fail closed without a scoped access facade; there is no raw-store fallback. The existing administrator-only classification suggestion policy and all other endpoint policies remain unchanged.

## PostgreSQL and proxy configuration follow-up

Runtime and maintenance commands now share validated `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`/`PGPASSWORD_FILE` inputs. Retired URL variables fail with explicit migration guidance. Off-host TLS is an explicit choice: `verify-full` authenticates the chain and configured hostname/IP, `require` is encryption-only with a warning, and `disable` is deliberate plaintext. No verification error downgrades a connection. System/public roots need no custom file; the optional custom-CA Compose override mounts an absolute host PEM file read-only. The bundled override retains explicit database/role/volume identities, uses plain TCP when TLS settings are unset, and keeps password files separate from app encryption/bootstrap secrets. `APP_BIND` is unchanged.

`TRUST_PROXY` validates bounded IP/CIDR lists with loopback always trusted. Client-IP resolution begins at the actual socket peer and walks a bounded X-Forwarded-For chain right to left, stopping at the first untrusted hop. Malformed chains fall back to the peer; equivalent IPv6/IPv4-mapped spellings share rate-limit keys. Caddy/cloudflared topology and source-NAT limitations are documented without assuming deployment addresses. Existing audit schema and authorization remain unchanged.

The additional 40 tests comprise 24 PostgreSQL configuration/TLS cases, 12 proxy/client-IP cases and four PG test-harness cases. Real `pg.Client` handshakes against an ephemeral TLS protocol fixture verify matching DNS/IP identities, unknown issuers, wrong DNS/IP SANs, expiration, plaintext rejection and explicit encryption-only behavior. A separate disposable PostgreSQL 17.6 server also negotiated TLS 1.3 with a synthetic private CA and matching IP SAN, and rejected that issuer under system/public roots. Synthetic certificate/private-key files were removed afterward; no live PostgreSQL or proxy settings were changed.

All ten browser commands and the 37-table restore rehearsal were rerun after migration. The browser enhancement check now awaits the actual cleared secret input, removing a timing race where its success notice appeared before asynchronous refresh completed. No production frontend behavior was changed in this follow-up.

## Automated results

- `npm run check`: **216 tests passed, zero failures and zero skips**, plus repository-wide ESLint, Prettier verification and production Vite build.
- The full test run explicitly enabled `DOLPHINO_DB_SHUTDOWN_TEST=1` on the disposable cluster. Both database shutdown/recovery tests ran, proving external actions fail closed during outage and resume after recovery. Never enable these tests against a live or shared database; their additional isolated-cluster checks require the test harness to supply the matching control executable, data directory and port.
- Nine new database-independent HTTP boundary tests cover the complete 76-endpoint method/path/access contract, actual endpoint mounting, default administrator access, member-scoped finance, exact Origin checks on public authentication, response headers, error redaction, rate limiting, date/query semantics and exact minor-unit report adaptation.
- Raw HTTP webhook tests preserve whitespace, duplicate JSON keys and non-ASCII bytes, and reject bodies larger than 1 MiB before provider handling.
- Sixteen new frontend model/API tests cover disjoint account/budget grants, identity/revision changes, reporting timezone, history/date/ID query scopes (including an explicit empty ID set), exact signed splits above Number precision, currency precision, budget allocation/rollover and API error handling.
- `npm run check:theme`: token references, semantic chart colors, AA text/focus contrast and original SVG geometry pass.
- Backup/restore using the repository shell scripts matches every row in all **37 public tables** and two complete financial reports. Encrypted credentials, grants, sessions, import jobs, immutable evidence, alerts, notification queues and sequence behavior survive.
- `npm audit --omit=dev --audit-level=high`: zero known production dependency vulnerabilities at this verification time.
- `git diff --check`: passes.

## Browser results

All ten browser commands passed against the current build or isolated source harness:

```sh
npm run test:browser
npm run test:browser:enhancements
npm run test:browser:auth
npm run test:browser:assistant
npm run test:browser:integration-settings
npm run test:browser:simplefin
npm run test:browser:theme
npm run test:browser:settings-mocked
npm run test:browser:workspace
npm run test:browser:brand
```

The actual demo backend, real HTTP/PostgreSQL integration settings and SimpleFIN flows passed. Other scenarios use explicitly intercepted synthetic API responses. Coverage includes all seven main screens, desktop/mobile layouts at 1440/390/320 pixels, financial drilldowns, exact split validation, cancelled editors, keyboard scrolling, Escape/focus restoration, exports, write-only credential fields, retry/error/empty states, household roles and read-only assistant interaction. Desktop and mobile screenshots were visually inspected; the ocean design and original dolphin artwork are retained.

The workspace suite covers failed cross-user and same-principal reloads, late previous-principal responses, delayed mutations/settings callbacks after navigation, and permission/editor invalidation. It includes a test-only permission-refresh harness; no test hooks are added to the production application.

A reusable guard runs before application code in every app browser suite and every relevant page. It rejects reads/writes through `localStorage`, `sessionStorage`, IndexedDB and Cache Storage, and rejects service-worker registration. Violations are recorded outside the document, so caught exceptions or navigation cannot hide an attempted access. A deliberate read/write negative-control test proves the guard fails even when page code catches the error. All actual app flows complete without a storage violation.

## Independent review and limits

A separate review compared original and extracted route handlers/policies, probed all 76 mounted endpoints, reran ten focused PostgreSQL security tests, and independently reproduced the fixed account-cache/navigation scenarios against the production build. It found no remaining refactor blocker. A further independent review of PG/TLS and proxy changes passed 52 focused tests (including Compose parsing and HTTP boundaries), found no remaining code blocker, and prompted corrections to upgrade/proxy documentation. Existing real HTTP adversarial tests, SSRF/DNS pinning/TLS tests, grant privacy tests and provider-secret redaction tests pass in the full suite.

This is a development verification record, not a security certification. A full Docker image build, real reverse-proxy/TLS deployment and real provider/notification/model calls were not run in this environment. The existing provider, deployment and backup caveats still apply. Database migrations, financial accounting rules and persistent credential formats were not changed by that earlier refactor. The subsequent cleanup deliberately retires version 1/2 envelopes; this historical statement does not promise current credential compatibility. Large ledger/import services retain their cohesive transaction and concurrency boundaries rather than being split only to reduce line counts.
