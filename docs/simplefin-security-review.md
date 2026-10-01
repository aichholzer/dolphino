# SimpleFIN security and financial-integrity review

## Boundaries

Only authenticated administrators can read integration configuration or initiate claims, tests, mappings, backfills, disabling and local disconnection. Existing same-origin mutation checks and sensitive-action rate limits cover the routes. The one-time claim has a durable hashed replay record created before any provider POST.

The network adapter revalidates HTTPS destinations, resolves every address, rejects the entire result if any address is non-public, and pins one validated address into the HTTPS lookup callback. The hostname remains the original TLS server name, certificate validation stays enabled, redirects are rejected, and the agent is not reused. The returned credential must belong to the original claim origin/root. DNS and requests have time limits; responses have byte limits. Exceptions expose only fixed error codes, never remote exception details, URLs or credentials.

Financial imports require explicit mapping. Cross-source and historical-connection merges are blocked. The direct Redbark worker skips reserved accounts, with an additional ledger guard protecting the race between discovery and ingestion. Exact monetary parsing rejects excess nonzero precision and bigint overflow. Posted records use stable source/account-scoped IDs; pending observations cannot cause heuristic merging.

Settings revisions fence asynchronously fetched results at commit. Database transactions serialize mapping and ledger changes. The durable worker keeps failed or partial windows queued, respects backoff and splits response-cap windows without boundary gaps. Raw provider structures and normalized records are retained separately in immutable evidence. Original IDs, timestamps, decimal amounts and extras remain available for audit; nested credential reflections are redacted, bounded and never exposed by the settings API.

## Independent findings corrected

The independent reviewer reproduced a completeness bug using the real adapter with a synthetic HTTP boundary: global errors containing HTML-only text and per-account errors containing control-only text became empty after sanitization. The adapter now preserves every error's presence, substituting a generic safe message. Tests verify that both levels remain incomplete and cannot produce a false complete import.

The reviewer also identified that initial evidence storage kept normalized projections only. Evidence now includes a bounded recursively credential-redacted provider record alongside its normalized ledger projection. Regression checks retain original transaction ID, decimal amount, transacted timestamp and nested reference while proving secret material is absent.

The independent adversarial test file covers real household sessions with PostgreSQL and HTTP. Its authorization matrix denied anonymous, member and forged-origin operations without any provider calls. Concurrent submissions of the same token produce one claim attempt; replay remains rejected after disconnect. Public readback and ciphertext do not contain the credential. Hostile empty-after-sanitizing error messages remain present.

## Explicit limitations

- This is a constrained v1 client, not full support for every possible SimpleFIN provider or the v2 draft
- No source migrations, account-history relinking or pending import in this first version
- Protocol responses cannot prove hidden upstream records are absent; limits/errors are surfaced, and coverage is never called reconciled
- Provider-specific skip rules may intentionally hide records; no client can recover records a provider withholds
- Local disconnect is not provider revocation
- Development and verification use synthetic fixtures only; real provider compatibility requires the user's own connection in their app
