// Destructive only to new, randomly named databases created by this script.
// Never accepts an existing source or target database name.
import pg from "pg";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { Store } from "../backend/src/store.js";
import { ensureRedbarkSchema } from "../backend/src/worker.js";
import { createClassificationIntegration } from "../backend/src/classification.js";

const connectionString = process.env.REHEARSAL_ADMIN_URL;
if (!connectionString)
  throw Error(
    "Set REHEARSAL_ADMIN_URL to a disposable local PostgreSQL server",
  );
const url = new URL(connectionString);
if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
  throw Error(
    "Restore rehearsal is restricted to a local test PostgreSQL server",
  );
const suffix = randomUUID().replaceAll("-", "");
const source = `profe_backup_test_${suffix}`;
const target = `profe_restore_test_${suffix}`;
const admin = new pg.Pool({ connectionString });
const pools = [];
const created = [];
const backupDir = await mkdtemp(join(tmpdir(), "profe-restore-rehearsal-"));
const env = {
  ...process.env,
  PGHOST: url.hostname,
  PGPORT: url.port || "5432",
  PGUSER: decodeURIComponent(url.username),
  ...(url.password ? { PGPASSWORD: decodeURIComponent(url.password) } : {}),
};
function connect(name) {
  const db = new URL(url);
  db.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: db.href });
  pools.push(pool);
  return pool;
}
async function snapshot(pool) {
  const names = (
    await pool.query(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
    )
  ).rows;
  const tables = {};
  for (const { tablename } of names) {
    assert.match(tablename, /^[a-z_]+$/);
    const { rows } = await pool.query(
      `SELECT row_to_json(t)::text AS row FROM "${tablename}" t ORDER BY row_to_json(t)::text`,
    );
    tables[tablename] = rows.map(({ row }) => row);
  }
  return tables;
}
try {
  for (const name of [source, target]) {
    await admin.query(`CREATE DATABASE ${name}`);
    created.push(name);
  }
  const srcPool = connect(source);
  const store = new Store(srcPool, { mode: "demo" });
  await store.migrate();
  await ensureRedbarkSchema(srcPool);
  await createClassificationIntegration({
    pool: srcPool,
    store,
    config: { mode: "demo" },
  }).init();
  await srcPool.query(
    "INSERT INTO classification_usage(mode,day,requests) VALUES('demo',(now() AT TIME ZONE 'UTC')::date,3)",
  );
  await store.seedDemo();
  const transaction = (await store.listTransactions()).find(
    (t) => t.status === "posted" && t.kind === "expense",
  );
  await store.correctTransaction(transaction.id, {
    category: "Restore verification",
    note: "Fictional backup rehearsal correction",
  });
  await store.saveRule({
    contains: "FICTIONAL BACKUP MATCH",
    category: "Restore verification",
    priority: 5,
  });
  const body = Buffer.from(
    JSON.stringify({
      id: "fictional-backup-event",
      type: "transactions.synced",
    }),
  );
  await srcPool.query(
    "INSERT INTO redbark_receipts(event_id,body,body_hash) VALUES($1,$2,$3)",
    [
      "fictional-backup-event",
      body,
      createHash("sha256").update(body).digest("hex"),
    ],
  );
  await srcPool.query(
    "INSERT INTO redbark_jobs(dedupe_key) VALUES('fictional-backup-job')",
  );
  await srcPool.query(
    "INSERT INTO redbark_fetches(account_id,fetched_at,raw) VALUES('fictional-backup-account',now(),'{\"fictional\":true}')",
  );
  await srcPool.query(
    "INSERT INTO classification_jobs(mode,transaction_id,fingerprint) VALUES('demo',$1,'fictional-backup-fingerprint')",
    [transaction.id],
  );
  const months = [
    ...new Set((await store.listTransactions()).map((t) => t.date.slice(0, 7))),
  ].sort();
  const beforeReports = await Promise.all(
    months.map((month) => store.report({ month, currency: "AUD" })),
  );
  const before = await snapshot(srcPool);
  console.log(
    execFileSync("sh", [resolve("scripts/backup.sh"), backupDir], {
      env: { ...env, PGDATABASE: source },
      encoding: "utf8",
    }).trim(),
  );
  const dumps = (await readdir(backupDir)).filter((n) => n.endsWith(".dump"));
  assert.equal(dumps.length, 1);
  console.log(
    execFileSync(
      "sh",
      [resolve("scripts/restore.sh"), join(backupDir, dumps[0])],
      {
        env: { ...env, PGDATABASE: target, PROFE_RESTORE_CONFIRM: target },
        encoding: "utf8",
      },
    ).trim(),
  );
  const dstPool = connect(target);
  const restored = new Store(dstPool, { mode: "demo" });
  assert.deepEqual(
    await snapshot(dstPool),
    before,
    "Every restored table row must exactly match",
  );
  assert.deepEqual(
    await Promise.all(
      months.map((month) => restored.report({ month, currency: "AUD" })),
    ),
    beforeReports,
    "Complete financial reports must match",
  );
  assert.equal(
    (await restored.getTransaction(transaction.id)).note,
    "Fictional backup rehearsal correction",
  );
  assert.ok((await restored.audit(transaction.id)).length > 0);
  await assert.rejects(
    dstPool.query("UPDATE provider_observations SET payload='{}'"),
    /immutable/,
  );
  const oldMax = (
    await dstPool.query("SELECT max(id)::text AS id FROM redbark_jobs")
  ).rows[0].id;
  const nextId = (
    await dstPool.query(
      "INSERT INTO redbark_jobs(dedupe_key) VALUES('fictional-after-restore') RETURNING id::text",
    )
  ).rows[0].id;
  assert.ok(BigInt(nextId) > BigInt(oldMax), "Sequences restored");
  console.log(
    JSON.stringify(
      {
        result: "PASS",
        server: (await admin.query("SHOW server_version")).rows[0]
          .server_version,
        source,
        target,
        counts: Object.fromEntries(
          Object.entries(before).map(([name, rows]) => [name, rows.length]),
        ),
        financialTotals: beforeReports.map((r, i) => ({
          month: months[i],
          currency: "AUD",
          incomeMinor: r.incomeMinor,
          expensesMinor: r.expensesMinor,
          netMinor: r.netMinor,
          pendingMinor: r.pendingMinor,
        })),
        checks: [
          "Every row in every public table matches exactly",
          "Complete financial reports including budgets/coverage match",
          "Manual correction and audit survive",
          "Immutable observation trigger survives",
          "Job sequence advances after restore",
        ],
      },
      null,
      2,
    ),
  );
} finally {
  for (const pool of pools) await pool.end();
  for (const name of created.reverse())
    await admin.query(`DROP DATABASE ${name}`);
  await admin.end();
  await rm(backupDir, { recursive: true, force: true });
}
