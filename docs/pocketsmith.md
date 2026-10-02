# PocketSmith personal import

PocketSmith is an optional, read-only source under **Settings → Bank feeds**. It is disabled by default. Each self-hosted owner supplies a personal developer key for their own PocketSmith account. This implementation does not register an OAuth application or claim PocketSmith approval. PocketSmith documents developer keys for personal tools and registered OAuth for apps serving other PocketSmith users; operating Dolphino as such a service requires resolving that registration separately. [Official authentication guidance](https://developers.pocketsmith.com/docs/introduction), [OAuth registration](https://developers.pocketsmith.com/docs/oauth).

## Setup

1. Configure the deployment's strong `APP_SECRET`. Settings uses the existing version 3 AES-GCM database credential vault. Keep the same secret across restarts and back up the database and secret securely.
2. Create a developer key in PocketSmith Settings → Security. Save it in Dolphino's PocketSmith panel. A blank field retains the saved key; replacing it pauses imports and requires another connection test.
3. Select **Test and discover accounts**, then explicitly select each native transaction account to import. Set the initial history depth (1–2555 days).
4. Enable imports and save. Backfills run in windows of at most 30 days, then normal polling runs every four hours per account. The worker starts with the application; status shows progress and failures.

The key itself may permit writes at PocketSmith. Dolphino's client sends only GET requests to fixed, allowlisted API paths. There is no provider write, webhook registration, bank refresh, or LLM call in this integration. No documented numeric rate limit or public webhook facility is assumed, and no real-time freshness is promised.

Administrators alone can view connection settings or change imports. Same-origin checks, action limits, current-role checks and configuration revisions protect writes. Keys are write-only, masked in responses and excluded from provider errors and persisted response echoes. No key or application state is stored in browser persistent storage. DNS answers must all be public, HTTPS pins the validated address while verifying the PocketSmith TLS hostname, and redirects are rejected.

## Identity, amounts and balances

Local account identities derive from the PocketSmith user ID and **native transaction-account ID**. Grouped Account IDs are separate metadata; grouped balances and `primary_transaction_account` never create additional local accounts. Relinking the same personal account with a new key preserves identities. A different PocketSmith user creates separate source identities. Manual accounts and other providers are never converted or merged. Selecting the same bank through multiple providers can therefore duplicate history. The distinctions follow the [official API schema](https://raw.githubusercontent.com/pocketsmith/api/master/openapi.json).

JSON numeric lexemes remain exact strings until converted with integer arithmetic to native-currency minor units. Fractional minor units, unsupported currencies, invalid dates, ambiguous identities and out-of-range amounts fail the complete import window. Converted/base-currency amounts never replace native amounts.

Balance evidence preserves the current-balance field, source date, native currency, safe balance and conversion metadata. The provider's date is displayed as a date, not an invented bank-sync timestamp. Older or missing balance dates cannot overwrite a newer observed balance. PocketSmith balance settings can use calculated, reversed, or provider/available balances; Dolphino does not infer which bank methodology produced a selected current balance. [PocketSmith balance settings](https://learn.pocketsmith.com/manage-your-accounts/6a6X8SseDCJ6tNxPieiTDD/balance-settings-for-an-account/6a6X8SseDCf9goscsQwegH).

## Transactions and local corrections

Provider transaction IDs are stable within their native account. Pending and posted states are retained. An absent pending record is not automatically deleted or linked to a posted record. Existing review controls handle ambiguous replacements.

Source categories receive stable local keys. A provider rename updates its display name, including historical transactions and budgets, until an administrator explicitly edits that category locally. Local rename/archive choices survive later imports. Categories and labels remain subject to existing account permissions. Imported labels are normalized to Dolphino tags, added within the 20-tag limit, and respect explicit local removals. Provider label disappearance never removes a local tag. Malformed labels fail validation; manual notes, categories, kinds and valid splits retain precedence. Source transfer/refund/deduction flags inform classification before existing rules and corrections apply.

Successful pages and original records are immutable evidence, with numeric precision preserved and credential echoes redacted before persistence. An older source `updated_at` cannot overwrite a newer canonical version; conflicting financial values at an identical timestamp fail the window. Failed or partial imports cannot advance the cursor or leave partial ledger changes.

## History, retry and account lifecycle

Polling combines `updated_since` with a recent 30-day reconciliation window. The cursor follows accepted provider timestamps, overlaps five minutes and never advances beyond the request start time. This avoids using a faster local clock as evidence that all provider updates were seen. Both start and end dates are always supplied for imports. PocketSmith's omitted-date defaults depend on the user's subscription; neither those defaults nor a successful response establishes complete bank history. [Transaction filters](https://developers.pocketsmith.com/reference/get_users-id-transactions-1).

Paging validates `Per-Page`, `Total` and `Link`, rejects changed account/date scopes, repeats and inconsistent totals, and requires the complete window before committing. Dolphino requests 500 records per page and bounds each page to 2 MiB, each query to 16 MiB/100 pages and roughly two minutes plus the current request deadline. Large windows or changing collections remain incomplete and retry; they are never treated as a complete snapshot. [Official pagination contract](https://developers.pocketsmith.com/docs/pagination).

Retries use exponential backoff and honor valid `Retry-After` seconds or dates across the entire connection. Invalid credentials require a successful new test. Worker locks prevent duplicate concurrent polls; revisions fence responses after key, selection, or settings changes. Manual history requests require both dates, an ordered range of at most 2555 days, and no existing queued backfill for that account. Tomorrow is included in automatic ranges to cover differing provider calendar days.

Frozen and soft-deleted accounts continue importing when enabled. Frozen balances stay outside account totals; soft-deleted history stays outside ordinary reports and budgets. Missing upstream accounts keep their local history and previous freshness. Local permanent deletion removes account-scoped PocketSmith evidence and cursors and retains the shared hashed-identity tombstone, preventing discovery or in-flight work from recreating that account. Disconnecting locally retains financial history; revoke the developer key at PocketSmith to revoke access.

## Verification

Use a disposable PostgreSQL database through `TEST_DATABASE_URL`:

```sh
node --test --test-concurrency=1 backend/test/pocketsmith*.test.mjs
npm run check
npm run test:browser:pocketsmith
```

The focused tests use real PostgreSQL and Rayo HTTP with a synthetic provider transport. The browser test uses the production React build, real sessions and database, an external-request blocker and a guard against browser persistent storage. No real financial provider or LLM is contacted.
