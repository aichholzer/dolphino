# Database integration settings upgrade

Start with [the complete upgrade guide](upgrading.md), including stopping every prior app/worker, preserving exact PostgreSQL storage and the current APP_SECRET, and reviewing pending deliveries. This checklist concerns configuration and credential recovery; it never requires a database wipe, seed or financial schema reset.

## Configuration sources

An administrator manages integrations in Settings. PostgreSQL is the sole runtime source for Redbark API/version/backfill and signing-secret configuration; classification provider/model/credentials/automation limits; the independent read-only assistant; Telegram/SMTP; and optional SimpleFIN. OpenAI and Bedrock have fixed secure provider URLs; custom LLM base URLs are unsupported.

Former integration environment variables and secret-file variants are ignored, with no import or fallback. Environment-only integrations stay paused until explicitly configured in Settings. Deployment mode, individual PostgreSQL `PG*` connection/TLS settings, HOST/PORT, APP*BIND, APP_ORIGIN, trusted proxies, bootstrap proof and APP_SECRET remain deployment-side. Transfer old branded values to current `DOLPHINO*\*` variables explicitly while preserving their intended values.

## Safe recovery checklist

1. Back up PostgreSQL and protect the matching APP_SECRET separately. Record the old application version. Confirm each integration's recovery path before upgrading, especially SimpleFIN's historical mapping limitation
2. Stop all prior app/worker processes. Upgrade against the same live database, role and volume without regenerating APP_SECRET. Financial observations, transactions, overrides, rules, budgets, receipts, jobs, users, grants, notification settings and outbox records remain stored
3. Sign in as an administrator; prior cookie names are no longer accepted, so sign in again if needed. Inspect stored financial data and integration status before restoring external activity
4. Replace or explicitly clear version 1/2 credentials. They remain stored but are unreadable in this release, even with the original key. Empty/omitted secret fields preserve ciphertext and do not repair it. Current version 3 credentials still need their matching APP_SECRET
5. For **Redbark**, enter the API key, API version and rolling backfill days, then save and test. Default rolling history is 90 days, bounded to 1–2555. API-key replacement invalidates the prior webhook binding: also supply the matching signing secret or explicitly register/recover the correct destination. Verify a synthetic receipt only when deliberately testing external delivery; a queued ping alone proves nothing
6. For **classification and assistant**, replace required provider credentials independently. Bedrock requires its region and required credential pair; OpenAI needs its own key. Blank saves retain ciphertext, and enabling with unreadable required credentials fails atomically. Review model, sharing consent, master enable, automatic-suggestions/application controls and request limits before enabling. Automatic application remains explicit opt-in
7. For **SMTP**, replace the saved SMTP URL or explicitly clear it; review recipients, sender, consent and pending deliveries. For **Telegram**, replace/clear the bot token, then explicitly pair and confirm the intended group again because replacement clears pairing. Configured/masked state does not establish availability; notification settings expose `credentialsAvailable` and a warning
8. For a configured but unreadable **SimpleFIN** Access URL, disconnect locally before using a new one-use setup token. Disconnect retains history and reserved mappings; reconnecting creates a new source identity. **Historical mapped accounts cannot be automatically relinked or resumed under it.** Do not assume this restores existing imports or erase financial records to bypass the limitation. Read [SimpleFIN ownership and recovery](simplefin.md) before disconnecting
9. Remove obsolete integration environment values/mounts after verifying configuration. Keep APP_SECRET and the selected PostgreSQL connection/TLS settings. Explicitly clear unused encrypted provider slots if they use retired formats; otherwise they still block offline key rotation

Settings changes apply immediately to subsequent operations, without restarting. Already accepted external calls may still finish. Missing, cleared or unreadable credentials pause or fail closed only the affected credential-dependent operations; they do not erase financial history or queued work.

## Restore and rotation

A PostgreSQL backup needs its separately protected matching APP_SECRET and compatible application version to decrypt credentials. Restore first into an isolated empty target, with external provider access blocked; validate record counts, ledger totals, corrections, grants, jobs and settings before deliberately switching the application. A restored backup can contain pending imports, model jobs and deliveries. See [backup and restore](deployment.md#export-backup-and-restore).

The current vault does not decrypt retired version 1/2 envelopes, even with the correct old key. Changing APP_SECRET alone is neither recovery nor rotation. [Offline key rotation](settings-security.md#explicit-offline-key-rotation) decrypts every stored credential atomically; any retired/unreadable row causes total rollback. Replace or explicitly clear all such rows through supported controls first. No automatic re-encryption occurs.

## Retained jobs after an account change

Queued jobs retain the credential-account identity that accepted them. Jobs from another API key, and older jobs whose account cannot be proven, remain stored and paused rather than being submitted under new credentials. Import Health continues to show retained jobs. After testing the saved connection, request a fresh bounded backfill for the current account if needed. A version-only change requires a fresh connection test but does not change existing jobs' account identity.
