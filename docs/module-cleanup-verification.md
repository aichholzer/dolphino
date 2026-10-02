# Module cleanup verification — 2 October 2026

This record covers the `.mjs`/backend-layout cleanup and removal of transitional identifiers, starting from commit `688931c44b0fd0bbcc9f848a932f4f6150540f24`. Earlier results in [maintainability verification](maintainability-verification.md) and [MVP verification](verification.md) are historical.

All verification used synthetic data and newly created loopback-only PostgreSQL 17.11 clusters. The test wrapper clears inherited connection settings before creating each cluster and removes its synthetic databases afterward. No deployed app, live household database, LAN database, provider credentials or real provider/notification calls were used.

## Changes and static verification

- Backend source root contains only `app.mjs` and `server.mjs`; 33 cohesive service modules live in `lib/`, with `demo.mjs`, `migrate.mjs` and `seed.mjs` under `utils/`. Existing `http/` and `routes/` responsibilities are retained
- Repository-owned plain JavaScript uses `.mjs`, including tests, shared helpers, maintenance scripts and ESLint/Vite configuration. JSX remains `.jsx`; generated Vite assets and dependency files keep their normal extensions
- All 13 SQL migrations match the baseline byte for byte. Accounting and provider state-machine modules were moved without arbitrary splitting or financial schema changes
- Case-insensitive retired-token scan is clean across repository-owned text, including source, tests, scripts, configuration, package/lockfiles and documentation. Historical Git commits and third-party/generated content are outside that scan
- Module-relative migration paths, imports, package commands and browser-harness source paths were updated. No stale local `.js` source imports remain
- Official `@stylistic/eslint-plugin` 5.10.0 declares ESLint 9/10 compatibility. Only the requested `padding-line-between-statements` rule is added, at error severity after `function`, `export` and `multiline-block-like` statements
- Recommended ESLint checks, braces and unused-variable policy remain active. Prettier retains 120 columns, two spaces, single quotes, semicolons, no trailing commas and parentheses around arrow parameters. Regression tests verify both exact settings and ESLint/Prettier fix stability

## Automated results

- `npm run check`: **259 tests passed, zero failures and zero skips**, with ESLint, repository formatting verification and the production Vite build
- Both isolated database shutdown/recovery tests ran under the explicit test-owned-cluster opt-in
- Six new credential-recovery tests cover independent v3 HKDF/AAD verification, discarded envelope rejection, unchanged financial/user/session rows, unavailable-but-configured masked status, no credential fallback or outbound calls, blank-save preservation, failed-enable rollback, explicit replacement/clear and atomic all-row rotation rollback
- Five style tests verify the exact three padding rules, existing lint safety rules, unchanged Prettier settings and formatter stability. Three deployment-safety tests cover canonical direct/file settings, duplicate/malformed session-cookie rejection and explicit restore-target confirmation
- `npm run migrate` and `npm run seed` succeed through the relocated utility entrypoints against a disposable demo database. The actual `npm start` process serves the compiled frontend and demo API through the browser wrapper
- Native `scripts/backup.sh` and `scripts/restore.sh`, driven by `scripts/restore-rehearsal.mjs`, restore **all 143 rows across 37 public tables** exactly, plus two complete financial reports. V3 encrypted credentials, sessions, grants, imported evidence, queues and sequence behavior survive
- The real official Docker Compose CLI configuration regression passes, covering external database identity, explicit bundled volume selection, TLS, secret mounts and `APP_BIND`. No Docker daemon or running image is implied by this check
- `npm run check:theme` passes source-token, original SVG and AA contrast checks

## Browser results

All checks used the current frontend build where applicable; provider transports were synthetic. Real HTTP/PostgreSQL suites did not intercept API responses:

- Integration Settings: 13 checks covering encrypted saves, preserve/clear semantics, credential/version changes, model-free Bedrock setup, independent assistant/classification settings, administrator/member boundaries and desktop/mobile rendering. Added retired-envelope cases show SMTP/Telegram/SimpleFIN recovery warnings with empty secret fields; explicit SMTP/Telegram replacement removes those warnings without sending externally
- SimpleFIN: real session, consent and one-use claim, masked credentials, discovery, mapping confirmation/cancel, actual synthetic import, reload, pause and local disconnect with retained history
- Bedrock lifecycle: all 12 scenarios pass, including Settings navigation, refresh/reload, browser restart, app restart, transient provider failures, slow/aborted requests and busy-state preservation
- Main demo, enhancements, authentication, assistant, theme, mocked Settings, workspace isolation and branding browser commands pass
- Review/import-health regressions pass, including exact amounts and 390/320-pixel layouts
- All seven compiled category-repair UI cases pass, including late responses, preserved manual fields, demo disablement and member visibility

The mocked Settings/workspace/review suites are explicitly synthetic UI tests, separate from the real HTTP/PostgreSQL suites. Browser-storage guards pass, and desktop/mobile screenshots were inspected. No external provider authorization or production deployment was performed.

## Breaking boundary and limits

The current vault reads only version 3 envelopes. Previous-format credentials remain stored but unavailable; this release never resets the database or silently re-encrypts them. Explicit recovery is integration-specific, especially SimpleFIN's unsupported historical-account relinking and Telegram re-pairing. Read [upgrading safely](upgrading.md) before changing a deployment. Keep the current APP_SECRET for readable credentials and matching backups; rotation cannot recover discarded envelope formats.

Independent review confirmed unchanged SQL migrations, no accidental accounting/frontend semantics from the moves/formatting, and the intended crypto/environment/cookie/namespace boundaries. It independently passed 21 focused tests with zero skips, parsed all 176 repository modules, resolved 532 relative import/URL references and checked local documentation links; no blocking regression was found.

A full Docker image build/runtime, real reverse-proxy/TLS deployment and real provider/model/notification calls were not run. This checkout has no Git metadata, so `git diff --check` is unavailable; equivalent source whitespace, conflict-marker, path, file-content and immutable-migration checks are used instead. This is development verification, not a security certification.
