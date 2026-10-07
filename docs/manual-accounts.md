# Manual accounts and account lifecycle

Every account is a local Dolphino account. A feed connection creates a local **feed** account; disconnection retains the local account and history. A **manual** account is created by an administrator. Origin is permanent. There is no feed/manual conversion, linking, matching or reconciliation. If both accounts are active, both balances count. Freeze or soft-delete an account to exclude its balance.

## Manual accounting

- Opening balances, dated income/expenses/refunds, two-sided transfers and balance adjustments are real local ledger records, never fabricated import observations.
- Amounts use signed integer minor-unit strings and BigInt/PostgreSQL numeric arithmetic. Each amount is limited to the signed bigint range. Currencies are summed separately; totals are not converted through floating point.
- Book balance is the opening balance plus active entries through the household's current date. Entries must be dated today or earlier and cannot precede the opening date. Opening balance/date can be corrected with a reason; the date cannot move past an existing entry.
- Opening balances and adjustments affect book balance only. They never create income, expenses, cash flow or budget spending. A new adjustment records the fixed delta between the target balance and book balance on the selected date. Later backdated entries do not silently rewrite that delta. Editing an adjustment explicitly edits its signed delta, with a reason.
- Activity supports existing category choices, multiple tags, notes and exact splits. Category renames change display labels; archiving retains existing keys, history and budgets. Saved archived classifications may be retained when editing.
- Transfers require two distinct active manual accounts and edit access to both. Same-currency amounts must match; cross-currency transfers require explicit sent and received amounts. Dolphino performs no FX conversion and moves no real money. Both legs are created/edited/voided atomically and remain excluded from income and spending.
- Entry identity, account and currency cannot be changed. Correct a mistake by editing the existing entry, or voiding it and creating a replacement. Voiding retains rows and audit history while removing balance/report effects; opening balances are corrected rather than voided. Transactions' **Show voided entries** exposes retained rows, explicitly marked as excluded. Administrators can open their history.
- Every change records before/after snapshots and the current actor. Revisions reject stale edits. Required request UUIDs deduplicate retries; reusing a UUID for different values fails. Permissions are checked again before returning cached writes. Receipts and financial changes commit atomically.
- Import rules and automatic classification do not rewrite manual entries. Feed transactions retain their existing category/tag correction workflow. Feed balances, amounts and dates cannot be edited as manual entries. Database constraints reject mixing manual entries with feed aliases/evidence or changing account origin.

## Lifecycle and permissions

| State        | Visible in ordinary UI     | Included in balances           | Historical reports/budgets/exports/assistant | Manual financial changes                                      |
| ------------ | -------------------------- | ------------------------------ | -------------------------------------------- | ------------------------------------------------------------- |
| Active       | Yes                        | Yes, when balance is available | Included                                     | Permitted account editors                                     |
| Frozen       | Yes                        | No                             | Included                                     | Blocked, including feed corrections and local account details |
| Soft-deleted | Only admin Settings → Data | No                             | Account's history excluded                   | Blocked                                                       |

Account editors may freeze, unfreeze and soft-delete their permitted accounts. Only administrators create manual accounts, restore deleted accounts or permanently delete them. Existing account grants are retained during soft deletion. Restoration preserves the prior frozen state. Lifecycle changes invalidate retained assistant authorization context, including separately granted budget totals.

Freezing never pauses feed imports. Soft-deleted feed accounts continue receiving hidden imports while the source supplies data. Disabling or deleting an account at the provider may stop updates; that external decision does not delete, freeze or recreate local history. The last stored update remains visible in account management. Restoring a local account exposes retained history and any updates imported while hidden. Lifecycle changes and restored history do not change account origin. A remaining transfer leg in another account stays a transfer; deletion cannot turn it into income. A linked manual transfer cannot be edited or voided until both accounts are active and permitted.

The Accounts and Overview balance summaries count each active permitted account once, separately per currency. Unknown feed balances are reported as unavailable, not silently treated as a verified zero. Feed snapshots are independent of imported spending; manual book balances are not bank-verified reconciliation.

## Permanent deletion

Settings → Data offers an admin-only local deletion preview showing selected names, affected record counts and linked account dependencies. All selected accounts must already be soft-deleted. The administrator must type the exact confirmation phrase. A changed preview fails closed and requires another preview.

A manual transfer, including a voided transfer, prevents permanent deletion of only one participating account. Every linked account must be explicitly soft-deleted and selected together. Scope is never automatically expanded. Cross-account pending replacement dependencies are also blocked.

Permanent deletion removes selected account rows, transactions, overrides, tags/preferences, transaction audit, manual entry audit, account-owned provider observations, SimpleFIN fetch evidence/jobs and transaction classification jobs. Shared budgets, category definitions and rules remain. Evidence is otherwise immutable: the purge uses a narrow transaction-local account scope, and evidence updates remain prohibited. Unrelated account records and evidence are preserved.

Minimal local/source identity tombstones, scrubbed SimpleFIN identity reservations, deletion counts and lifecycle events remain. Financial response bodies in request receipts are erased, while request IDs and fingerprints remain to reject delayed retries of deleted writes. Polls cannot recreate a tombstoned local account ID; SimpleFIN discovery also checks its hashed source identity. Source identifiers are retained solely to prevent recreation. A provider that changes both its account/source identity can appear as a new account; this mechanism does not infer that it is the deleted account. No external deletion, bank operation or disconnection is performed. Previously exported files and independent backups are unaffected; this is not a backup erasure feature. Permanent deletion cannot be restored through the UI.

## Tests

Use disposable PostgreSQL only. `TEST_DATABASE_URL=... npm test` includes the manual ledger HTTP/authorization/lifecycle suite and the upgrade test. `npm run build` followed by `TEST_DATABASE_URL=... node frontend/test/manual-accounts.browser.mjs` runs the compiled React application against actual local Rayo/SQL endpoints. Only disconnected integration status panels are browser fixtures; financial APIs are real. Browser storage and external calls are rejected by the browser harness.
