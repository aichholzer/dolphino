# Dolphino identity and module reference audit

The canonical repository is `https://github.com/aichholzer/dolphino`. Product UI, package names, configuration examples, source assets and current operational guidance use Dolphino identifiers. Historical compatibility aliases are removed from current source rather than carried as alternate product names.

## Artwork

`frontend/public/dolphino.svg` is the editable dolphin silhouette used by the application; `dolphino-mono.svg` is the one-color alternative. Both use SVG geometry with accessible title/description and no embedded raster image, font or external resource. Source copies are under `artifacts/`; the lowercase wordmark remains separate UI text set in the interface face, Hanken Grotesk. The dedicated `npm run test:browser:brand` command checks icon sizes and desktop/mobile placement; consult the dated verification records for actual executed results.

## Current reference policy

- Plain JavaScript modules use `.mjs` throughout backend, frontend helpers, shared code, tests, scripts and JavaScript configuration. JSX files stay `.jsx`
- `backend/src/app.mjs` and `server.mjs` are the only backend source-root files. Reusable services are in `lib/`, maintenance/demo entrypoints in `utils/`, route declarations in `routes/` and HTTP boundary code in `http/`
- The 13 substantive SQL migrations remain intact. Module cleanup does not erase database history or introduce a financial schema reset
- Current branded environment values use `DOLPHINO_*`; only `dolphino_session` is read as the session cookie
- Credential encryption uses a Dolphino-specific version 3 HKDF/AAD domain. Older envelopes are stored but unreadable; there is no compatibility decryptor or automatic conversion
- Worker advisory locks and SMTP Message-ID namespaces use current identifiers. All prior app/worker processes must stop before an upgrade; pending deliveries require review
- Actual existing database, role and physical volume names are operator-owned storage identifiers, not branding targets. Retain those exact values rather than creating new storage

## Audit and upgrade evidence

The cleanup acceptance checks include a case-insensitive scan for the retired product token across tracked source, tests, package/lockfiles, configuration, scripts and documentation, plus checks for stale local `.js` imports and entrypoint paths. Generated dependencies/build output and immutable Git history are outside the current source tree. Do not interpret an earlier milestone's compatibility result as a current promise.

See [architecture](architecture.md), [upgrade and recovery boundaries](upgrading.md) and [current cleanup verification](module-cleanup-verification.md) for current expectations and the results actually recorded. The earlier [maintainability](maintainability-verification.md) and [MVP verification](verification.md) documents are historical records; their former cookie, alias and credential compatibility assertions do not apply to this release.
