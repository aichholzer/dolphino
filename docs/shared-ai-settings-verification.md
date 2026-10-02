# Shared AI settings verification — 2 October 2026

This record concerns the Settings submenu and one shared OpenAI/Bedrock connection with independent classification/assistant feature controls. Earlier [module-cleanup](module-cleanup-verification.md), [model-discovery](bedrock-model-discovery.md), [security](database-settings-security-review.md) and [MVP](verification.md) totals describe their original milestones; they are not current aggregate results.

## Integrated checks

- Combined `npm test`: **280 passed, zero failures and zero skips** against disposable PostgreSQL 17
- Repository-wide ESLint and `format:check`: passed
- Production build: passed; emitted `index-BFKdwYDd.js` and `index-Dkm6e0V2.css`
- Actual isolated `npm run migrate`: passed and created all three canonical documents, `ai.provider`, `ai.classification` and `ai.assistant`

## Independent review

The review found and fixed four issues: nested-transaction lock release, migration of an irrelevant OpenAI region, Bedrock dispatch after a configuration change during preflight, and deletion of a mismatched retired legacy credential slot. Dedicated reproducible PostgreSQL and mocked-provider regressions verified the fixes. **49 independent tests passed**; this is a separate review run, not an additional aggregate total.

## Confirmed final browser checks

The compiled browser runs used synthetic providers and isolated fixtures:

- Shared Bedrock lifecycle: **12/12**
- Actual PostgreSQL/HTTP integration Settings: **12/12**
- Mocked Settings and race coverage: **14/14**
- Category repair: **7/7**
- Authentication, enhancements, main demo check and theme: passed

Final assistant, brand and real PostgreSQL/HTTP SimpleFIN browser reruns also passed on that build. Separate synthetic navigation and workspace suites passed against the final frontend source, covering active-only sections, deep links, Back/Forward/reload, dirty-form cancellation, principal/grant changes, late responses, responsive layouts and the browser-storage guard.

## Restore rehearsal

The updated `scripts/restore-rehearsal.mjs` passed on a newly initialized, loopback-only PostgreSQL **17.11** cluster. The isolated wrapper clears inherited database inputs and generates disposable credentials. The script creates randomly named source/target databases, invokes the repository's actual `backup.sh` and `restore.sh`, and removes both databases and the temporary dump in `finally`.

Verified in this run:

- Exact JSON rows across **37 public tables / 143 rows**, including timestamps, ciphertext, canonical shared AI documents, sessions, grants, queues, imports and immutable provider evidence
- One `ai.apiKey` row, no active legacy AI credential rows/documents, and two actual restored feature runtime snapshots using that same decrypted shared key
- Distinct classification/assistant models; classification enabled with automatic suggestions/application disabled, daily limit 7 and batch size 3
- Assistant disabled with sharing unacknowledged, daily request limit 3, two tool calls, two rounds and 512 output tokens; its durable quota remains reserved and rejects the exhausted allowance
- Shared and feature public metadata/revisions and runtime configurations match the source snapshots exactly, with no plaintext credential in public output
- Both missing and wrong APP_SECRET fail credential access closed for both features, retain configured/unreadable metadata and leave every restored row unchanged
- Complete reports for both fixture months match, including budgets and coverage; October AUD income 665000, expenses 354874, net 310126 and pending -4295 minor units; September expenses 4500 minor units
- Manual correction/audit, authentication/session/bootstrap state, notification outbox, Redbark and SimpleFIN state, immutable-evidence triggers and sequence continuation survive

This is an offline synthetic OpenAI-credential restore fixture, not a live OpenAI/Bedrock inference or a claim of real account access. Provider/notification transports are never called. It verifies database persistence and actual shared-service restoration; broader HTTP/browser behavior must be established by its separate checks.

Reproduction from the repository root with the provided isolated test tools:

```sh
../dolphino-test-tools/with-postgres.sh node scripts/restore-rehearsal.mjs
```

The wrapper is a development fixture outside the repository. Otherwise supply explicit `PG*` settings for a disposable loopback PostgreSQL server with `CREATEDB` capability, compatible `pg_dump`/`pg_restore` binaries, and run `node scripts/restore-rehearsal.mjs`. Never target a household database or use a deployment credential.

## Verification scope

The edited rehearsal also passes focused ESLint and Prettier checks. No production deployment, LAN connection, live financial/provider call, new credential grant, account change or Git publication was performed. These development checks do not establish real provider access or production deployment readiness.
