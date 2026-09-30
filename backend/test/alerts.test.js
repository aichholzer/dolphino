import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { Store } from "../src/store.js";
const connectionString =
  process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
test(
  "durable alerts are generated with dashboard closed, deduplicate, resolve and reopen across writes",
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
      const read = async () =>
        (await pool.query("SELECT * FROM budget_alerts ORDER BY category"))
          .rows;
      assert.equal((await read())[0].amount_minor, "500");
      const reports = await Promise.all(
        Array.from({ length: 6 }, () => store.report(filters)),
      );
      assert.ok(reports.every((r) => r.alerts[0].amountMinor === "500"));
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
      assert.ok((await read())[0].resolved_at);
      await store.correctTransaction(tx.id, { category: "Groceries" });
      assert.equal((await read())[0].id, first.id);
      assert.equal((await read())[0].resolved_at, null);
      await store.ingest({
        ...observation,
        sourceId: "refund",
        amountMinor: "600",
        kind: "refund",
        date: "2026-09-03",
      });
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
      assert.ok((await read())[0].resolved_at);
      await store.ingest({
        ...observation,
        sourceId: "late-import",
        amountMinor: "-500",
        date: "2026-08-31",
      });
      assert.equal((await read())[0].amount_minor, "400");
      assert.equal((await read())[0].id, first.id);
      assert.equal((await read()).length, 1);
      assert.equal(
        (await new Store(pool, { mode: "demo" }).report(filters)).alerts.length,
        0,
      );
      assert.equal((await read())[0].resolved_at, null);
      // Rules recalculate amounts while preserving manual precedence; deletion resolves identities.
      const rule = await store.saveRule({
        contains: "Fictional groceries",
        category: "Dining",
      });
      assert.equal((await read())[0].amount_minor, "500");
      await store.deleteRule(rule.id);
      assert.equal((await read())[0].amount_minor, "400");
      assert.equal((await read())[0].resolved_at, null);
      const september = (await store.listBudgets()).find(
        (b) => b.month === filters.month,
      );
      await store.deleteBudget(september.id);
      assert.ok((await read())[0].resolved_at);
      await store.saveBudget({
        ...filters,
        category: "Groceries",
        capMinor: "100",
      });
      assert.equal((await read())[0].resolved_at, null);
      assert.equal((await read())[0].id, first.id);
      // Pending rows do not spend; a posted replacement generates the alert on ingestion.
      await store.saveBudget({
        ...filters,
        category: "Transport",
        capMinor: "100",
      });
      const pending = await store.ingest({
        ...observation,
        sourceId: "pending-travel",
        category: "Transport",
        status: "pending",
      });
      assert.equal((await read()).length, 1);
      await store.ingest({
        ...observation,
        sourceId: "posted-travel",
        replacesSourceId: "pending-travel",
        category: "Transport",
      });
      assert.equal(
        (await read()).find((a) => a.category === "Transport").amount_minor,
        "1400",
      );
      assert.equal((await store.getTransaction(pending.id)).status, "posted");
      // Acceptance uses the same ledger and commits alerts; stale suggestions cannot override a correction.
      await store.saveBudget({
        ...filters,
        category: "Health",
        capMinor: "100",
      });
      const unknown = await store.ingest({
        ...observation,
        sourceId: "unknown",
        category: null,
        description: "Unknown fictional merchant",
      });
      await store.resolveReview(unknown.id, { action: "keep" });
      assert.equal(
        (await store.getTransaction(unknown.id)).reviewRequired,
        false,
      );
      assert.equal(
        await store.markAutomaticClassificationReview(unknown.id, unknown),
        true,
      );
      assert.equal(
        (await store.getTransaction(unknown.id)).reviewReason,
        "Category needs review",
      );
      assert.equal(
        (
          await store.acceptAutomaticClassification(
            unknown.id,
            "Health",
            unknown,
          )
        ).applied,
        true,
      );
      assert.equal(
        (await read()).find((a) => a.category === "Health").amount_minor,
        "1400",
      );
      await store.ingest({
        ...observation,
        sourceId: "unknown",
        category: null,
        description: "Unknown fictional merchant",
      });
      assert.equal((await store.getTransaction(unknown.id)).category, "Health");
      assert.equal(
        (await store.getTransaction(unknown.id)).manuallyCorrected,
        false,
      );
      await store.correctTransaction(unknown.id, { category: "Shopping" });
      assert.equal(
        await store.markAutomaticClassificationReview(unknown.id, unknown),
        false,
      );
      assert.equal(
        (await store.getTransaction(unknown.id)).reviewRequired,
        false,
      );
      assert.ok(
        (await read()).find((a) => a.category === "Health").resolved_at,
      );
      assert.equal(
        (
          await store.acceptAutomaticClassification(
            unknown.id,
            "Health",
            unknown,
          )
        ).applied,
        false,
      );
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
