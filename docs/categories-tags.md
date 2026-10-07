# Categories, tags and transaction search

## Category lifecycle

Review details, transaction editing (including splits), rule editing and budget creation use a server-loaded category dropdown. The catalog combines the default vocabulary, administrator-created categories, meaningful imported labels, existing corrections, split categories, budgets and rules. Opaque `cat_` provider references are excluded from the vocabulary. A saved unresolved reference remains a safe, readable option in its existing editor until someone explicitly chooses a category; saving unrelated fields preserves the original key.

Administrators manage categories in **Settings → Categories**:

- Create a category shared as household vocabulary. This does not grant access to transactions or reveal usage.
- Rename its display name. `category` remains the stable ledger key. Transaction/split/budget/rule responses carry `categoryDisplayLabel` when the name differs. All historical budget IDs, grants, category matching, rollover, overrides, source identities and provider observations remain unchanged.
- **Delete (archive)** removes a category from new-entry choices. History and existing budgets retain it, and filters still find it. Editing an existing archived assignment or budget remains possible; assigning it to a different transaction or a new budget period is rejected. Existing provider imports and rules continue to use their saved keys. Restore makes it selectable again.
- The fallback `Uncategorized` cannot be renamed or archived. Duplicate names/keys are rejected case-insensitively. Financial writes and category changes share the existing mode-specific PostgreSQL advisory transaction lock.

Imported/correction categories are visible to members only through their granted accounts or budgets. Private transfer category names are replaced by the existing `Transfers` presentation. Catalog responses carry no household usage counts. Administrator-created/default vocabulary is shared, while renaming or archiving a private imported category does not make it globally visible.

An existing budget's category is fixed in the editor. Rename it through Settings to preserve its identity and grants; create another budget explicitly when a different category is wanted.

## Tags and search

Transaction edits support up to 20 distinct tags of 1–40 characters. Tags are trimmed, lowercased, sorted and deduplicated. Add a tag with **Add tag** or Enter, remove individual tags with their labelled buttons, then save the correction. A tag-only edit does not create a financial override or dismiss a review. Tags survive provider updates and appear in transaction results, exports and authorized assistant transaction details. Pending-to-posted linking combines effective tags and applies the latest explicit manual choice for each tag across the two records. Explicit removals stay removed; a later manual re-add wins. A combined set over 20 tags fails atomically until labels are reduced.

Members need account edit permission to change tags. Transfer labels remain administrator-only and are redacted from member results, search matches, suggestions, counts, exports and assistant output. Tag suggestions come from visible, non-superseded transactions (up to 1,000 distinct suggestions). No application data is stored in browser persistent storage.

Text search is a case-insensitive literal substring search across descriptions, correction notes, displayed category names, split category names and tags. `%`, `_` and backslash are escaped, never treated as user-supplied SQL wildcards. Search strings are capped at 200 characters. Category and exact tag filters combine with the existing account, date/month/history, status, type and drilldown filters. Filtering and counts run in PostgreSQL before pagination (default 50, maximum 100 rows per page). Export selects all authorized matches rather than the displayed page. A category filter includes complete matching split transactions; existing report projection semantics remain unchanged.

Assistant finance tools accept a nullable `tag` filter and continue to recheck current grants. Their `merchant` field remains description-only, preserving the prior merchant contract. Category keys remain the stable values returned with transaction details; display labels are included separately. Assistant aggregate/export limits remain unchanged.

## Review action semantics

The former blanket **Keep separate** action sends `action: "keep"`. The backend clears only that transaction's `review_reason`, adds a `review-kept` audit entry and refreshes derived alerts. It does not merge anything, remove pending records, change category/kind/amount, create a correction or change spending totals. A transfer remains excluded from income and expense totals. Unchanged classification evidence respects the decision; new evidence or classification work may request another review.

The UI now shows **Keep separate** for source-identity/replacement warnings, **Accept current classification** for classification warnings and **Dismiss warning** for other warnings. Compatible posted identity reviews retain **Link pending**. Help text explains the effect and transfer exclusion. Accounting semantics are unchanged.

## Rules and global search

Administrators can create or edit rules on **Rules**, or choose **Create rule** on a Transactions or Review row. Both row actions open the same editor with the literal description, saved category key (displaying its current name), transaction type and tags. Nothing is created by opening or cancelling it. Descriptions over 200 characters require an explicit match rather than silently becoming a broader prefix. Existing archived or unresolved rule assignments and an unspecified imported type can be retained; new rules require an active catalog choice.

**Preview matches** is read-only. It counts all matching non-superseded imported descriptions and shows up to 20 examples, including higher-priority rules, manual corrections, tags to add, previously removed tags and tag-capacity limits. Editing after preview disables save until the current values have a matching preview. Saving applies to imported history and future imports. A preview is a current snapshot, not a reservation: new imports or another administrator's edits may change the scope before save. Rules still match literal substrings ignoring letter case, with priority descending then stable rule ID as the existing tie-breaker.

Only the first matching rule contributes tags. Tags are additive: changing or deleting a rule leaves tags already applied. Manual tag removals are recorded separately and suppress re-addition by any rule or repeated import; explicitly re-adding a tag restores it. At the 20-tag limit, extra automatic labels are skipped, keeping imports and existing manual labels intact. Repeated application inserts no duplicate tags or tag-addition audits. Tags never change money, source observations, split amounts, notes or financial overrides. Existing category/type rule behavior remains separate: a user-approved rule can reclassify non-manual transactions and resolve classification reviews as before.

The permanent header search is available on every workspace page with account access. Submitting or clearing it opens **Transactions**, searches all imported history in the displayed default currency, and clears prior account, month/date, category, tag, status, type, exact-ID and page scopes. Budget-only users cannot use transaction search. Transaction criteria live in the URL fragment (never results or permissions), so refresh and back/forward restore the selection; local filter edits replace the current history entry. Logout clears the current route. Every request rechecks server-side grants. Unsaved Settings, rule, transaction, account and budget drafts guard navigation and browser history. No browser storage API is used.

## API and migration

- `GET /api/categories`: scoped `catalog` entries `{category, name, archived}` plus the legacy active `categories` key array.
- `GET /api/tags`: scoped tag suggestions.
- `GET /api/settings/categories`: administrator catalog.
- `POST /api/settings/categories`: `{name}`.
- `PATCH /api/settings/categories`: `{category, name? , archived?}`.
- `DELETE /api/settings/categories`: `{category}` archives it.
- `PATCH /api/transactions/:id`: optional `tags` array, alongside existing correction fields.
- `POST /api/rules/preview`: administrator-only read-only scope preview, using the same strict body as saving.
- `POST /api/rules`: `{id?, match, category, kind?, priority?, tags?}`; existing omitted tags are preserved. Tags use the same normalization/limits as transaction tags. Rule updates and tag additions are audited.
- Transaction/export queries: optional exact `tag` and existing `category`, `search`/`q` filters.

All category management endpoints use the default administrator policy and exact-Origin mutation check. Payload schemas reject unknown fields. Member reads use the request-scoped access facade. Category changes and tag corrections are audited.

Migration `014_categories_tags.sql` is additive and idempotent. It creates category metadata and transaction tag tables plus account/date, tag lookup and trigram search indexes. It does not update provider observations, original transactions, overrides or existing budgets. The PostgreSQL installation must provide **pg_trgm**: the migration role needs database `CREATE` permission to install this trusted extension, or a database administrator can install it first. An existing installation in another schema is supported. Normal indexes may take time and block writes on large ledgers; run migrations during the usual stopped-worker upgrade window with a backup. No deployment was performed for this change.

Migration `015_rule_tags.sql` adds rule tag arrays and explicit transaction tag preferences. Its one-time data marker records pre-existing tags as manual choices; subsequent startup migrations must not promote generated tags into manual choices. It changes no money, historical category keys, budgets, overrides or import evidence. The normal `npm start` / Compose startup applies both migrations through `Store.migrate()`; `npm run migrate` also applies them. For migration 014, a DBA can preinstall `CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;` in the existing application database if the application role lacks database CREATE permission. Do not reset the database.

## Tests

The disposable PostgreSQL 17 fixture uses synthetic data, real database sessions, actual Rayo HTTP and the production Vite build. No worker or financial/LLM network integration starts. Browser tests reject external requests and instrument localStorage, sessionStorage, IndexedDB, Cache Storage and service-worker registration.

```sh
# Configure TEST_DATABASE_URL or PG* for a disposable database, never a live household database.
npm run check
npm run test:browser:categories
npm run test:browser:rules-search
npm run test:browser:workspace
npm run test:browser:reviews
npm run check:theme
```

`backend/test/categories-tags-http.test.mjs` verifies role/Origin/schema rejection, concurrent creation, mode isolation, private vocabulary, multiple tag validation, unchanged totals/evidence/overrides, historical budgets and rollover after rename/archive, migration reruns, pagination beyond 50 rows, literal escaping, filtered exports, assistant filters, grant revocation and atomic pending tag merging. `frontend/test/categories-tags.browser.mjs` exercises the compiled app with admin/editor/viewer sessions, refresh, navigation, repeated mutations, contextual review actions, category choices, archived history, exact budget saving, escaped HTML, mobile management and storage/network guards.

The two database outage tests stay opt-in; see [testing](testing.md#database-outage-tests).

`backend/test/rule-tags-http.test.mjs` covers role/Origin/schema boundaries, read-only preview snapshots, first-match precedence, literal wildcard characters, concurrency, repeated imports/migrations, explicit removal/re-add, capacity, mode isolation and pending-link decisions. `frontend/test/rules-search.browser.mjs` exercises real authorized sessions against compiled assets, both row entry points, shared dropdowns, preview gating, cancellation/history guards, additive tags, global search from every page, stale-scope clearing, refresh/back/forward, mobile layout and revoked grants. The workspace and Review runners serve production bundles, compile their isolated test harnesses and reject development-source requests.

Screenshots from the synthetic fixtures: [Categories on mobile](../artifacts/categories-settings-mobile.png), [filtered transactions on desktop](../artifacts/categories-transactions-desktop.png), [rule preview](../artifacts/rule-preview-desktop.png) and [permanent search on mobile](../artifacts/rules-global-search-mobile.png).
