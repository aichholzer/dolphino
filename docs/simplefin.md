# Optional SimpleFIN import

Direct Redbark v2 remains Dolphino's primary integration. SimpleFIN is an additional **read-only client**: it imports accounts, balances and posted transactions into the same ledger. Dolphino does not expose a SimpleFIN server, make banking writes, or automatically switch any Redbark account.

SimpleFIN is a protocol; SimpleFIN Bridge is one provider. This adapter targets the [v1 protocol](https://www.simplefin.org/protocol-v1.html), including the date/account/balances-only parameters implemented by [Redbark](https://redbark.com/docs/api-reference/simplefin). It does not implement the v2 connection/structured-error schema.

## Connect in Settings → Bank feeds

1. Sign in as an administrator in live mode. Ensure the existing APP_SECRET can encrypt credentials. No new environment variables are needed.
2. Generate an app setup token at your provider. Paste it into **Settings → Bank feeds → SimpleFIN optional import** and select **Connect SimpleFIN**.
3. The server attempts the one-use claim exactly once. The resulting Access URL is encrypted with the existing credential vault in PostgreSQL. It is never returned to the form. The new connection starts paused.
4. Select **Test and discover accounts**. This fetches account metadata and balances, without importing transactions.
5. For each desired account, select **Map as a new account** and confirm that it is not already being imported through another source. Nothing is silently mapped.
6. Select **Enable scheduled imports**, then save. Initial import jobs are already queued for mapped accounts. Polling runs every four hours, with a worker checking durable jobs every 15 seconds.

Setup tokens and Access URLs are credentials. Enter the token only in your own authenticated Dolphino app. Do not put either value in chat, repository files, command lines, logs or screenshots.

### Supported provider constraints

Providers must use public DNS hostnames, HTTPS with trusted certificates on port 443, a `/claim/:token` setup endpoint, and an Access URL on the **same origin and root path** as that claim endpoint. Cross-origin claims, redirects, HTTP, IP literals, private/LAN servers and nonstandard ports are deliberately unsupported. These restrictions are stricter than the general protocol and protect the server from SSRF and credential forwarding. No organization, currency or metadata URL is fetched.

Redbark currently implements SimpleFIN v1 for banking accounts. Its unused setup tokens expire after seven days. Reads have a documented 2,000-transaction account limit, and available history is capped around seven years. SimpleFIN is pull-only; it does not deliver immediate webhooks. Provider rules and upstream bank history can affect what is returned. Dolphino cannot independently prove upstream completeness.

## Account ownership and duplicates

A mapping reserves one ledger account for one source, including while paused or locally disconnected. Direct Redbark skips SimpleFIN-owned accounts, and the ledger rejects competing batch imports.

For Redbark's own SimpleFIN host, its `redbark_account_id` hint identifies a possible direct account. Mapping is blocked if that account already exists, or a direct Redbark key is configured. Hints from other providers are not trusted. If direct Redbark is configured later, it still cannot import a reserved account.

Generic providers cannot reliably identify accounts already supplied by another provider. The administrator must confirm that each new mapping is genuinely separate. Dolphino never compares amounts, dates or names to merge financial records.

**This first version does not support source migration or historical relinking**, even after disconnecting and reconnecting the same provider. Previously mapped identities remain reserved so a new connection cannot duplicate or silently replace their history. Pause a working connection when you want to retain its ability to resume. Revoke/disconnect only when you intend to remove its credentials. A future migration requires verified transaction-ID mapping and a reviewable reconciliation workflow.

## Import behavior and coverage

- Initial history defaults to 30 days and is configurable from 1 to 2,555 days before mapping. Changing this value does not requeue previously completed history
- Polls overlap the prior seven days, capped at 30 days. Use each mapped account's explicit backfill form to fetch older changes. Backfill dates are UTC boundaries, inclusive start and inclusive selected end date; requests use exclusive end timestamps
- Initial and manual backfills use durable windows of at most 30 days. Responses containing 2,000 or more transactions are not ingested as complete; the job splits into smaller, gap-free windows. Certain rejected-window HTTP statuses also trigger bounded splitting
- Split windows stop at one second for count limits. If a minimum window is still too large, the job remains visibly incomplete rather than dropping records
- Provider errors, including messages that become empty after sanitization, always mark coverage incomplete. Returned valid records can be preserved while failed windows remain queued for retry. Recent job errors remain visible even if another window succeeds
- HTTP 429 honors Retry-After, including delays longer than a day. An unrepresentable delay or one exceeding ten years disables further requests until an explicit reconnection; it is not silently shortened. Other failures use exponential backoff up to four hours. Jobs survive restarts; repeated requests are deduplicated
- Disabling imports retains the credential, mappings, history and queued work. Re-enabling resumes the source. In-flight results are fenced against concurrent settings/credential changes
- Pending records are excluded in this version, even if a provider returns them without being asked. Only posted records reach reports. The protocol cannot generally prove that differently identified pending and posted records are the same transaction
- Transaction IDs are scoped to source and account. Exact decimal strings become integer minor units without floating-point money or rounding. ISO currencies supported by the runtime are accepted; custom currency URLs and unknown currencies are visibly unsupported
- Provider categories are not assumed. Existing local rules and optional classification handle new records. Stable-ID refreshes preserve manual categories, notes and valid splits. Amount changes keep the existing ledger's audited split-review behavior

The account coverage shown elsewhere in Dolphino is the latest fetched window, not a claim that every historical period is complete. The SimpleFIN panel shows queued/retrying windows and the last complete response.

## Disconnect and recovery

**Disconnect locally** removes the saved credential, stops new imports, fences old asynchronous responses, and retains financial history and reserved mappings. It does not remotely revoke the connection. Revoke the corresponding app in your provider's own settings separately; the v1 protocol has no standard revoke endpoint used here.

If claiming fails, times out, loses the database, or is interrupted, the token may already have been consumed remotely. Its fingerprint is durably recorded before sending. Do not retry it. Revoke that token or app connection at the provider and create a new token. An interrupted claim can be cleared with **Disconnect locally**. A 403 can mean an invalid, already-used or compromised token.

Credentials, source identities, mappings, claim replay protection, immutable source evidence and jobs are part of the PostgreSQL backup. Retain the matching APP_SECRET separately. A missing or wrong key fails credential access closed. Current vault rotation preserves the source identity only for a readable version 3 credential; any retired version 1/2 row makes the entire rotation roll back. Retaining its original key does not make a retired envelope readable in this release.

For a configured but unreadable Access URL, use **Disconnect locally** before claiming a new one-use setup token. Disconnect retains financial history and reserved mappings, but the next claim creates a new source identity. Historical account relinking is unsupported, so this does **not** automatically resume imports into previously mapped accounts, even for the same provider. Do not wipe financial data to bypass the ownership boundary. Review this limitation before upgrading or disconnecting; see [upgrade recovery](upgrading.md#recover-saved-integrations-explicitly).

## Tests

Synthetic-only tests live in:

- `backend/test/simplefin-client.test.mjs`: public-network restrictions, pinned DNS/TLS host, redirect rejection, time/body limits, one-time claim behavior, protocol parsing and exact money
- `backend/test/simplefin-integration.test.mjs`: real PostgreSQL, immutable original-source provenance with recursive credential redaction, ledger corrections, durable retry/restart, source conflicts, stale-result fencing and boundary/account identities
- `backend/test/simplefin-independent-adversarial.test.mjs`: independent real PostgreSQL sessions/HTTP authorization matrix, concurrent claims, replay/readback and hostile provider errors
- `frontend/test/simplefin.browser.mjs`: actual compiled frontend, backend HTTP, household session and PostgreSQL with only outbound provider transport mocked
- `backend/test/restore-rehearsal.mjs`: full backup/restore comparisons, including SimpleFIN credential/source/job/evidence state
