# Repair Redbark category names in place

Do not wipe the database or repeat a history import to fix category names. Redbark v2 categories are taxonomy references such as `cat_…`; human-readable names come from the category taxonomy. Existing provider observations remain the evidence for the repair.

## Administrator steps

1. Update to a version containing the category repair action. Existing migrations run normally; no destructive or one-off SQL migration is needed.
2. In **Settings → Integration settings**, test the current Redbark connection. The key needs access to the imported accounts and `categories:read`.
3. In **Settings → Import health & history**, select **Repair category names**. This checks accessible accounts and refreshes the category taxonomy. It does not request bank balances, download transaction history, or queue a backfill.
4. Review the result counts. A completed four-hour polling bucket does not prevent this action. Active imports and provider backoff must finish before retrying.
5. For saved category references needing review, open **Transactions**, edit the transaction and explicitly choose its category. Review any counted budgets and rules against the repaired names. Their saved category keys are deliberately left unchanged.

## What changes and what stays

The repair updates only derived provider/category labels and category-only review flags for existing, current direct-Redbark transactions in accounts accessible with the currently verified credentials. It includes imported history outside the rolling polling window. Accounts mapped to SimpleFIN, unavailable accounts, superseded transactions and observations from unrelated providers are excluded.

Transaction identities, money, dates, status, financial kind, notes, splits, manually chosen categories and immutable provider observations stay intact. Derived budget alerts are recalculated in the same financial transaction. Rules remain authoritative over provider labels.

Older transaction editors saved the displayed category even when only the transaction type changed. The old audit cannot prove whether such a category was intentional. Consequently, existing manual category overrides and split categories are never silently renamed. Matching references are counted for explicit review. The current editor submits a category only when the user actually edits it, avoiding new copied defaults.

Evidence-backed unresolved provider references receive a human-readable **Unresolved category** display label. The stored category key is still used for exact filtering, export, budgets and rules. User-authored category strings without matching provider evidence remain literal. Saved budgets and rules using legacy references are counted for review, not blindly renamed or merged.

## Failure and concurrency behavior

The action is administrator-only, requires the configured Origin and a strict empty JSON body, and is unavailable in demo mode. It uses the same cross-process worker lock and credential-settings lock as imports. The verified credential revision is checked before fetching and again before applying changes. Account access and all category pages must load successfully before the local repair is committed. A missing scope reports an actionable permission error without changing transaction categories. Provider 429/503 responses establish global backoff; repeated clicks cannot bypass it.

Normal imports also repair existing local category names before fetching balances or transaction history. A later balance outage therefore does not prevent a successfully fetched taxonomy from repairing already imported rows.
