# Database integration settings: independent adversarial review

**Historical scope:** this record predates the shared-AI settings change. Descriptions of independent classification/assistant credentials and per-form discovery describe that earlier implementation, not current behavior. Current production uses one shared connection, separate feature controls and one model catalog; see [shared AI settings](ai-settings.md) and [its verification record](shared-ai-settings-verification.md). The original dated evidence and counts below are preserved, not claimed as new runs.

Review date: 2026-10-01. Scope: the database-only Redbark, classification-provider and separate assistant-provider changes in this worktree.

## Findings and fixes

### 1. Redbark connection-test endpoint lacked its sensitive-action rate gate

An authenticated administrator issued seven immediate `POST /api/connection/test` requests with `{}` and the correct `Origin`. Initially all seven returned HTTP 200 and reached the mocked Redbark provider. The corresponding classification and assistant connection tests were already bounded to five requests per minute.

The implementation now applies the sensitive-action gate to the Redbark endpoint. The same live HTTP attack returns `200,200,200,200,200,429,429`. No sixth or seventh provider call is made. The limiter is process-local; this review does not establish a distributed limit across multiple application instances.

### 2. Webhook callback DNS policy accepted transition addresses

The existing callback-address helper treated IPv6 `2002:7f00:1::1` as public even though its 6to4-embedded IPv4 address is loopback. With the provider and DNS boundaries mocked, an authenticated `POST /api/settings/webhook/register` containing `{"publicBaseUrl":"https://finance.dolphino.app"}` returned HTTP 200 and invoked the mock provider's destination-list and destination-create methods twice in total.

This demonstrates acceptance of an unsafe callback candidate, not a successful internal-network exploit. Neither the callback nor the real provider was contacted. A remote webhook provider might independently reject such a destination. The implementation now reuses the conservative public-address policy already used for SMTP. Replaying `2002:7f00:1::1`, `192.0.2.15`, `2001:db8::1` and `127.0.0.1` returns HTTP 409 with zero remote calls for every address. Final callback DNS resolution and delivery still belong to Redbark; the app does not perform or pin that external delivery.

## Execution and coverage

Final combined replay: **28 tests passed, zero failures, zero skips**, including ten newly added adversarial HTTP groups and the actual Chromium security test. A separate replay of the automatic-classification and registration suites passed **10 additional tests with zero skips**, for **38 passing focused tests** overall. Both reproduced findings are resolved in the reviewed worktree.

All integration probes ran against a newly initialized, isolated PostgreSQL 17.6 instance and a real listening HTTP server. Tests seed synthetic administrator/member sessions in PostgreSQL, then authenticate requests through the application's real session middleware. They do not replace HTTP authorization with mocks. No real credentials, accounts, integrations, public callback requests or LAN traffic are involved.

Added regression suite: `backend/test/database-settings-adversarial-http.test.mjs`.

- Seventy direct anonymous/member/forged-or-missing-Origin probes across settings, provider tests, assistant tests, webhook registration and Redbark connection-test routes; denied requests made zero outbound calls
- Database-only unconfigured defaults despite legacy integration environment values; nonexistent integration `*_FILE` paths ignored
- Strict rejection of `baseUrl` and `endpoint` fields targeting metadata-service addresses; all recorded OpenAI/Redbark calls used fixed HTTPS destinations with redirects rejected
- Encrypted database rows and settings responses contain no submitted synthetic secrets; exception messages containing those secrets are sanitized before HTTP responses
- Real AWS SDK construction exercised through HTTP, with only SDK `send` boundaries mocked: hostile endpoint environment variables ignored, database credentials explicitly provided, classification/assistant credentials isolated, temporary AWS keys rejected
- Five-request limits on ten sensitive endpoints; inference test requests without explicit cost acknowledgement made no model call
- Wrong `APP_SECRET`, modified authentication tags, assistant/classifier cross-slot ciphertext swaps and API/signing-secret swaps fail closed
- In-flight provider testing retains its original coherent key/model pair during a hot save; subsequent requests use the new pair and assistant settings remain separate
- In-flight old-account Redbark verification is rejected with HTTP 409 after replacement; a newer successful verification remains valid
- Old signing secrets fail webhook authentication after an API-key/account change; old destination IDs are not reused, and old queued jobs are not executed with new-account credentials
- Automatic classification runs only when its independent switch is enabled, respects the daily cap, rechecks manual changes, pauses durable jobs when switched off and preserves behavior across restart
- Manual classification remains usable with automatic classification disabled; disabling the provider stops calls; member finance grants do not grant settings access or expose another account through assistant tools
- Actual PostgreSQL shutdown causes generic HTTP failures and zero outbound requests; background operations fail closed; an explicit PostgreSQL restart restores successful settings reads and connection testing
- Existing assistant/account-access HTTP regression suites passed, including private chats/reports, fresh-grant checks during model execution and revocation/restoration invalidation
- Existing compatibility tests passed for historical crypto domains, persisted database settings and legacy session migration
- Existing security regression passed with actual Chromium: hostile stored HTML did not execute, and role/CSRF/proxy/injection/static-header/deployment-mode checks passed

## Reproduction

Run the focused suite with `TEST_DATABASE_URL` pointing exclusively at a disposable local PostgreSQL instance:

```sh
node --test --test-concurrency=1 backend/test/database-settings-adversarial-http.test.mjs
```

The destructive database-outage test is opt-in. It additionally requires all of:

- `DOLPHINO_DB_SHUTDOWN_TEST=1`
- `DOLPHINO_TEST_PG_ISOLATED=1`, explicitly declaring the fixture disposable and test-owned
- `DOLPHINO_TEST_PG_CTL`, the PostgreSQL control binary
- `DOLPHINO_TEST_PG_DATA_DIR`, that fixture's data directory
- `PGPORT`, its local TCP port

The outage test stops that instance and restarts it on loopback with Unix sockets disabled. Do not point these variables at any shared, live or user-owned database.

Browser regression command, with the executable provided by the test environment:

```sh
CHROMIUM_PATH=/path/to/chromium-headless-shell node --test backend/test/security-adversarial.test.mjs
```

## Boundaries and residual uncertainty

The review does not certify absence of vulnerabilities. Provider calls, DNS, destination registration and SDK execution were mocked at outbound boundaries; no real provider account permissions, remote webhook delivery, subscription billing, public DNS rebinding or real-model behavior were tested. Secret-redaction checks cover persisted credentials and returned application errors; production proxy, infrastructure and database logging configurations were not audited. The Chromium run covers the existing XSS/security fixture, not a full new-settings visual or accessibility review. Aggregate full-suite/build results belong to the main implementation verification.
