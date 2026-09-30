# Isolated backup and restore rehearsal

Executed 2026-09-30 against the disposable local PostgreSQL 18.4 server on `127.0.0.1:54329`. No real user database or live provider connection was used. The existing `profe_test` database was used only as the administrative connection; source and target were newly created databases with random names. Both rehearsal databases and the temporary dump were deleted in `finally` after verification.

The repository's actual `scripts/backup.sh` invoked `pg_dump --format=custom`, then `scripts/restore.sh` invoked `pg_restore --single-transaction --exit-on-error` into the new empty target. This was a native PostgreSQL tool rehearsal, not a JSON export/import simulation.

PostgreSQL 18.0 client tools were compiled from the official PostgreSQL `REL_18_0` GitHub source under `/tmp`; Bison, Flex and M4 packages from Debian's official repository were extracted under `/tmp` without system installation. The source server reports 18.4; major versions match. Standard deployments can use installed PostgreSQL 18 client tools instead.

Run from the repository root (requires `CREATEDB` privileges on a disposable loopback server):

```sh
PATH=/tmp/postgres-REL_18_0/src/bin/pg_dump:$PATH \
LD_LIBRARY_PATH=/tmp/postgres-REL_18_0/src/interfaces/libpq \
REHEARSAL_ADMIN_URL=postgresql://profe@127.0.0.1:54329/profe_test \
node scripts/restore-rehearsal.mjs
```

The reusable script rejects non-loopback hosts and never accepts an existing database name as a source or restore target. It seeds fictional demo records, then adds an actual correction, classification rule, audit event, queued classification job, webhook receipt, sync job and fetch evidence. Budget and financial mutations create overspend alerts before any report is opened; a fictional daily classification-request counter is also seeded. Exact JSON row content was compared across **all 15 public tables**, including timestamps and raw evidence; complete backend reports for both fixture months matched. Corrections/audit history, immutable observation trigger and sequence continuation were checked separately.

Observed output (monetary amounts are exact integer AUD cents):

```text
Backup written to /tmp/profe-restore-rehearsal-kXfgvz/profe-20260930T105923Z.dump
Restored to profe_restore_test_262fc40cd36c43b68bcdba335790a8e0. Verify totals and settings before switching the app.
{
  "result": "PASS",
  "server": "18.4",
  "source": "profe_backup_test_262fc40cd36c43b68bcdba335790a8e0",
  "target": "profe_restore_test_262fc40cd36c43b68bcdba335790a8e0",
  "counts": {
    "accounts": 3,
    "audit_history": 1,
    "budget_alerts": 2,
    "budgets": 7,
    "classification_jobs": 1,
    "classification_usage": 1,
    "provider_observations": 28,
    "redbark_fetches": 1,
    "redbark_jobs": 1,
    "redbark_receipts": 1,
    "redbark_state": 1,
    "rules": 3,
    "source_aliases": 28,
    "transaction_overrides": 1,
    "transactions": 28
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
    "Every row in every public table matches exactly",
    "Complete financial reports including budgets/coverage match",
    "Manual correction and audit survive",
    "Immutable observation trigger survives",
    "Job sequence advances after restore"
  ]
}
```

The demonstrated September totals were income **AUD 6,650.00**, expenses **AUD 3,548.74**, net **AUD 3,101.26**, with pending **AUD -42.95** reported separately. August expenses were **AUD 45.00**. Source and restored reports matched, including budget and coverage details. Fixture dates follow the current demo month when rerun.

This proves the application database backup/restore path, including immutable triggers and durable work/evidence tables. It does not back up server-side configuration/secrets, database roles, TLS certificates, or an external provider account; operators must preserve those separately as described in deployment instructions.
