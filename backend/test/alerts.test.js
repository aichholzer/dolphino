import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { Store } from "../src/store.js";
const connectionString =
  process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
test(
  "durable alerts deduplicate concurrent reads, resolve and reopen after corrections and late imports",
  { skip: !connectionString },
  async () => {
    const admin = new pg.Pool({ connectionString });
    const schema = `test_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString,
      options: `-c search_path=${schema}`,
    });
    const store = new Store(pool, { mode: "live" });
    const filters = { month: "2026-09", currency: "AUD" };
    try {
      await store.migrate();
      const observation = {
        sourceId: "purchase",
        accountId: "fictional",
        currency: "AUD",
        amountMinor: "-1500",
        status: "posted",
        date: "2026-09-02",
        description: "Fictional groceries",
        category: "Groceries",
        kind: "expense",
      };
      const tx = await store.ingest(observation);
      await store.saveBudget({
        ...filters,
        category: "Groceries",
        capMinor: "1000",
      });
      const reports = await Promise.all(
        Array.from({ length: 6 }, () => store.report(filters)),
      );
      assert.ok(reports.every((r) => r.alerts[0].amountMinor === "500"));
      const read = async () =>
        (await pool.query("SELECT * FROM budget_alerts ORDER BY category"))
          .rows;
      const [first] = await read();
      assert.equal((await read()).length, 1);
      const restarted = new Store(pool, { mode: "live" });
      await restarted.report(filters);
      assert.equal((await read())[0].id, first.id);
      assert.equal(
        (await read())[0].updated_at.toISOString(),
        first.updated_at.toISOString(),
      );
      await store.correctTransaction(tx.id, { category: "Dining" });
      assert.equal((await store.report(filters)).alerts.length, 0);
      assert.ok((await read())[0].resolved_at);
      await store.correctTransaction(tx.id, { category: "Groceries" });
      assert.equal((await store.report(filters)).alerts.length, 1);
      assert.equal((await read())[0].id, first.id);
      assert.equal((await read())[0].resolved_at, null);
      await store.ingest({
        ...observation,
        sourceId: "refund",
        amountMinor: "600",
        kind: "refund",
        date: "2026-09-03",
      });
      assert.equal((await store.report(filters)).alerts.length, 0);
      assert.ok((await read())[0].resolved_at);
      // Late prior-month spending reduces positive rollover and raises this month's alert.
      await store.saveBudget({
        month: "2026-08",
        currency: "AUD",
        category: "Groceries",
        capMinor: "1000",
        rollover: true,
      });
      await store.saveBudget({
        ...filters,
        category: "Groceries",
        capMinor: "0",
        rollover: true,
      });
      assert.equal((await store.report(filters)).alerts.length, 0);
      await store.ingest({
        ...observation,
        sourceId: "late-import",
        amountMinor: "-500",
        date: "2026-08-31",
      });
      assert.equal(
        (await store.exportSnapshot(filters)).summary.alerts[0].amountMinor,
        "400",
      );
      assert.equal((await read())[0].id, first.id);
      assert.equal((await read()).length, 1);
      assert.equal(
        (await new Store(pool, { mode: "demo" }).report(filters)).alerts.length,
        0,
      );
      assert.equal((await read())[0].resolved_at, null);
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
