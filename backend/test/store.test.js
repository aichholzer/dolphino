import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { Store } from "../src/store.js";
const connectionString =
  process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
test(
  "PostgreSQL immutable ingestion, concurrency, corrections, pending identities and mode isolation",
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
    try {
      await store.migrate();
      const obs = {
        provider: "redbark",
        sourceId: "one",
        accountId: "bank",
        currency: "AUD",
        amountMinor: "-1000",
        status: "posted",
        date: "2026-09-01",
        description: "Coffee",
        category: "Dining",
        kind: "expense",
        fetchedAt: "2026-09-01T10:00:00Z",
        raw: { provider: "evidence" },
      };
      await Promise.all(Array.from({ length: 8 }, () => store.ingest(obs)));
      assert.equal((await store.listTransactions()).length, 1);
      assert.equal(
        (await pool.query("SELECT * FROM provider_observations")).rowCount,
        1,
      );
      await store.ingest({ ...obs, sourceId: "two" });
      assert.equal(
        (await store.report({ month: "2026-09" })).expensesMinor,
        "2000",
      );
      const id = (await store.listTransactions())[0].id;
      await store.correctTransaction(id, {
        category: "Work",
        note: "Keep this correction",
        splits: [
          { category: "Work", amountMinor: "-600" },
          { category: "Dining", amountMinor: "-400" },
        ],
      });
      const aliases = (
        await pool.query(
          "SELECT source_id FROM source_aliases WHERE transaction_id=$1",
          [id],
        )
      ).rows;
      await store.ingest({
        ...obs,
        sourceId: aliases[0].source_id,
        category: "Other",
        fetchedAt: "2026-09-02T10:00:00Z",
      });
      assert.equal((await store.getTransaction(id)).category, "Work");
      assert.equal((await store.getTransaction(id)).splits.length, 2);
      await assert.rejects(
        () => pool.query("UPDATE provider_observations SET payload='{}'"),
        /immutable/,
      );
      assert.ok(
        (await store.listTransactions({ category: "Work" })).some(
          (t) => t.id === id,
        ),
      );
      assert.ok(
        (await store.listTransactions({ category: "Dining" })).some(
          (t) => t.id === id,
        ),
      );
      await store.ingest({
        ...obs,
        sourceId: aliases[0].source_id,
        amountMinor: "-1100",
        fetchedAt: "2026-09-03T10:00:00Z",
      });
      assert.equal((await store.getTransaction(id)).splits.length, 0);
      assert.match((await store.getTransaction(id)).reviewReason, /splits/);
      assert.ok(
        (await store.audit(id)).some((a) => a.action === "split-invalidated"),
      );
      await store.correctTransaction(id, { category: "Work", splits: [] });
      await store.ingest({
        ...obs,
        sourceId: aliases[0].source_id,
        amountMinor: "-1",
        fetchedAt: "2026-09-01T10:00:00Z",
      });
      assert.equal((await store.getTransaction(id)).amountMinor, "-1100");
      await store.updateAccount({
        id: "bank",
        currency: "AUD",
        name: "Bank",
        balanceMinor: "10000",
        fetchedAt: "2026-09-05T00:00:00Z",
      });
      await store.updateAccount({
        id: "bank",
        currency: "AUD",
        name: "Old Bank",
        balanceMinor: "999",
        fetchedAt: "2026-09-04T00:00:00Z",
      });
      assert.equal((await store.listAccounts())[0].balanceMinor, "10000");

      await store.ingest({
        ...obs,
        sourceId: "p1",
        status: "pending",
        amountMinor: "-3500",
      });
      const p = (await store.listTransactions({ status: "pending" }))[0];
      await store.correctTransaction(p.id, { category: "Travel" });
      await store.ingest({
        ...obs,
        sourceId: "posted1",
        replacesSourceId: "p1",
        amountMinor: "-3500",
        fetchedAt: "2026-09-03T10:00:00Z",
      });
      assert.equal((await store.getTransaction(p.id)).status, "posted");
      assert.equal((await store.getTransaction(p.id)).category, "Travel");
      await store.ingest({
        ...obs,
        sourceId: "p1",
        status: "pending",
        amountMinor: "-3500",
        fetchedAt: "2026-09-04T10:00:00Z",
      });
      assert.equal((await store.getTransaction(p.id)).status, "posted");
      await store.ingest({
        ...obs,
        sourceId: "ambiguous-p",
        status: "pending",
        amountMinor: "-500",
      });
      await store.ingest({
        ...obs,
        sourceId: "ambiguous-posted",
        amountMinor: "-500",
      });
      let reviews = await store.listReviews();
      assert.equal(reviews.length, 2);
      const posted = reviews.find((t) => t.status === "posted"),
        pending = reviews.find((t) => t.status === "pending");
      await store.resolveReview(posted.id, {
        action: "link",
        pendingId: pending.id,
      });
      assert.equal((await store.listReviews()).length, 0);
      assert.equal(
        (await store.listTransactions({ status: "pending" })).length,
        0,
      );
      const count = (await store.listTransactions()).length;
      await assert.rejects(() =>
        store.ingestBatch({
          account: { id: "atomic", name: "Atomic", currency: "AUD" },
          transactions: [
            { ...obs, sourceId: "valid" },
            { ...obs, sourceId: "bad", amountMinor: "0.5" },
          ],
        }),
      );
      assert.equal((await store.listTransactions()).length, count);
      assert.equal(
        (await pool.query("SELECT * FROM accounts WHERE id='atomic'")).rowCount,
        0,
      );
      const demo = new Store(pool, { mode: "demo" });
      assert.equal((await demo.listTransactions()).length, 0);
      await demo.seedDemo();
      const first = (await demo.listTransactions())[0];
      await demo.correctTransaction(first.id, {
        note: "Preserve repeated seed",
      });
      await demo.seedDemo();
      assert.equal(
        (await demo.getTransaction(first.id)).note,
        "Preserve repeated seed",
      );
      assert.ok(
        (await demo.report({ month: new Date().toISOString().slice(0, 7) }))
          .incomeMinor !== "0",
      );
      assert.equal((await store.listTransactions()).length, count);
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
