# Historical isolated backup and restore rehearsal — 30 September 2026

This is a historical rehearsal record. Its credential-decryption results require the matching application version and APP_SECRET. The current version 3 vault rejects version 1/2 backup ciphertext even with its original key; see [upgrade and rollback guidance](upgrading.md) and [current cleanup verification](module-cleanup-verification.md).

Executed 2026-09-30 against the disposable local PostgreSQL 18.4 server on `127.0.0.1:54329`. No real user database or live provider connection was used. The existing isolated test database was used only as the administrative connection; source and target were newly created databases with random names. Both rehearsal databases and the temporary dump were deleted in `finally` after verification.

The repository's actual `scripts/backup.sh` invoked `pg_dump --format=custom`, then `scripts/restore.sh` invoked `pg_restore --single-transaction --exit-on-error` into the new empty target. This was a native PostgreSQL tool rehearsal, not a JSON export/import simulation.

PostgreSQL 18.0 client tools were compiled from the official PostgreSQL `REL_18_0` GitHub source under `/tmp`; Bison, Flex and M4 packages from Debian's official repository were extracted under `/tmp` without system installation. The source server reports 18.4; major versions match. Standard deployments can use installed PostgreSQL 18 client tools instead.

Run from the repository root (requires `CREATEDB` privileges on a disposable loopback server):

```sh
PATH=/tmp/postgres-REL_18_0/src/bin/pg_dump:$PATH \
LD_LIBRARY_PATH=/tmp/postgres-REL_18_0/src/interfaces/libpq \
REHEARSAL_ADMIN_URL="$TEST_DATABASE_URL" \
node scripts/restore-rehearsal.mjs
```

The reusable script rejects non-loopback hosts and never accepts an existing database name as a source or restore target. It seeds fictional demo records, then adds an actual correction, classification rule, audit event, queued classification job, webhook receipt, sync job and fetch evidence. Budget and financial mutations create overspend alerts before any report is opened; a fictional daily classification-request counter is also seeded. Exact JSON row content was compared across **all 32 public tables**, including timestamps and raw evidence; complete backend reports for both fixture months matched. Corrections/audit history, immutable observation trigger and sequence continuation were checked separately. Five encrypted synthetic credentials (classification API key, separate assistant API key, Redbark signing key, SMTP URL and Telegram bot token) and the provider settings document also survived exactly. All decrypted only with the separately retained synthetic master key; missing-key credential access failed closed without affecting restored financial reports.

The extended rehearsal also seeds pending and sent notification outbox rows without sending, durable notification events with revisions, remote webhook registration metadata, a backfill job with retry state, and local account label/description overrides. All rows and states survive byte-for-byte. Notification send functions are injected to throw if accidentally called; no provider or notification network call runs.

Observed output (monetary amounts are exact integer AUD cents):

```text
{
  "result": "PASS",
  "server": "18.4",
  "source": "dolphino_backup_test_9913ab6a71d44eba984d74de5b3d7f48",
  "target": "dolphino_restore_test_9913ab6a71d44eba984d74de5b3d7f48",
  "counts": {
    "accounts": 3,
    "app_settings": 2,
    "assistant_usage": 1,
    "audit_history": 2,
    "budget_alerts": 2,
    "budgets": 7,
    "classification_jobs": 1,
    "classification_usage": 1,
    "encrypted_credentials": 5,
    "household_auth_limits": 1,
    "household_auth_state": 1,
    "household_demo_users": 0,
    "household_invitations": 1,
    "household_security_audit": 1,
    "household_sessions": 1,
    "household_users": 2,
    "notification_events": 3,
    "notification_outbox": 2,
    "provider_observations": 28,
    "redbark_fetches": 1,
    "redbark_jobs": 2,
    "redbark_receipts": 1,
    "redbark_state": 1,
    "rules": 3,
    "source_aliases": 28,
    "transaction_overrides": 1,
    "transactions": 28,
    "user_access_revisions": 0,
    "user_account_grants": 1,
    "user_budget_grants": 1,
    "webhook_registration": 1
  },
  "financialTotals": [
    {
      "month": "2026-08",
      "currency": "AUD",
      "incomeMinor": "0",
      "expensesMinor": "4500",
      "netMinor": "-4500",
      "pendingMinor": "0"
    },
    {
      "month": "2026-09",
      "currency": "AUD",
      "incomeMinor": "665000",
      "expensesMinor": "354874",
      "netMinor": "310126",
      "pendingMinor": "-4295"
    }
  ],
  "checks": [
    "Independent encrypted assistant credentials and durable per-user quota restore without any provider request",
    "Household users, hashed sessions, hashed invitations, closed bootstrap and independent resource grants survive",
    "Every row in every public table matches exactly",
    "Complete financial reports including budgets/coverage match",
    "Manual correction and audit survive",
    "Immutable observation trigger survives",
    "Job sequence advances after restore",
    "Pending/sent notification outbox, durable transitions and registration state match",
    "Backfill job parameters/retry state and account local labels survive",
    "Synthetic SMTP and Telegram encrypted credentials restore without sending",
    "Encrypted provider and signing credentials restore with separately retained master key",
    "Missing master key fails credential access closed after restore"
  ]
}
```

The demonstrated September totals were income **AUD 6,650.00**, expenses **AUD 3,548.74**, net **AUD 3,101.26**, with pending **AUD -42.95** reported separately. August expenses were **AUD 45.00**. Source and restored reports matched, including budget and coverage details. Fixture dates follow the current demo month when rerun.

This proves the application database backup/restore path, including immutable triggers and durable work/evidence tables. It does not back up server-side configuration/secrets, database roles, TLS certificates, or an external provider account; operators must preserve those separately as described in deployment instructions.

Household-upgrade rehearsal also preserved two synthetic named accounts, one hashed live session, a hashed invitation, closed-bootstrap state, authentication audit/rate-limit records, and independent account-view/budget-edit grants. The restored session resolved its synthetic administrator and public setup remained closed. No token or password plaintext was written to the evidence output; no email was sent.

Assistant verification adds the independent encrypted assistant credential/settings namespace and per-user request quota. Its restored synthetic credential decrypts only with the retained master key, remains disabled, and is distinct from classification. The restored quota retains its reserved count and rejects an already-exhausted limit. Assistant conversations/reports are transient process memory and are not part of the PostgreSQL backup.

The deployment-mode lock is included in the restored database; it prevents accidentally restarting this database under the other mode.
