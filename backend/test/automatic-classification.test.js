import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { Store } from "../src/store.js";
import { readConfig } from "../src/config.js";
import { createClassificationIntegration } from "../src/classification.js";

const connectionString =
  process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
async function fixture(run, max = 1) {
  const admin = new pg.Pool({ connectionString });
  const schema = `automatic_test_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({
    connectionString,
    options: `-c search_path=${schema}`,
    max,
  });
  const store = new Store(pool);
  const config = {
    mode: "demo",
    llmBaseUrl: "https://example.test/v1",
    llmApiKey: "fictional",
    llmModel: "small",
    llmBatchSize: 5,
    llmDailyRequestLimit: 20,
  };
  const account = { id: "fictional", name: "Fictional", currency: "AUD" };
  let sequence = 0;
  const ingest = async (patch = {}) => {
    const sourceId = patch.sourceId || `tx-${++sequence}`;
    const observation = {
      sourceId,
      accountId: account.id,
      currency: "AUD",
      date: "2026-09-01",
      description: `Unknown shop ${sourceId}`,
      amountMinor: "-2500",
      status: "posted",
      ...patch,
    };
    await store.ingestBatch({ account, transactions: [observation] });
    return (await store.listTransactions()).find(
      (t) => t.description === observation.description,
    );
  };
  try {
    await store.migrate();
    await run({ pool, store, config, ingest });
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
}
const reply = (category = "Groceries") =>
  Response.json({
    choices: [
      {
        message: {
          content: JSON.stringify({
            category,
            reason: "Fictional category suggestion",
          }),
        },
      },
    ],
  });

test("automatic classification defaults and cost controls validate", () => {
  const cfg = readConfig({ DATABASE_URL: "postgresql://example.test/demo" });
  assert.equal(cfg.llmAutoClassify, true);
  assert.equal(cfg.llmAutoApply, false);
  assert.equal(cfg.llmDailyRequestLimit, 20);
  assert.equal(cfg.llmBatchSize, 5);
  for (const patch of [
    { LLM_BATCH_SIZE: "0" },
    { LLM_DAILY_REQUEST_LIMIT: "1.5" },
    { LLM_AUTO_APPLY: "yes" },
  ])
    assert.throws(() =>
      readConfig({ DATABASE_URL: "postgresql://example.test/demo", ...patch }),
    );
});

test(
  "automatic imports enqueue bounded deduplicated suggestions without dashboard, rules/provider/manual/pending/transfer bypass",
  { skip: !connectionString },
  async () =>
    fixture(async ({ pool, store, config, ingest }) => {
      const wanted = await ingest();
      await store.resolveReview(wanted.id, { action: "keep" });
      assert.equal(
        (await store.getTransaction(wanted.id)).reviewRequired,
        false,
      );
      await ingest({ status: "pending" });
      await ingest({ category: "Transport" });
      await ingest({ kind: "transfer" });
      const manual = await ingest();
      await store.correctTransaction(manual.id, { category: "Groceries" });
      await pool.query(
        "INSERT INTO rules(id,mode,contains,category,priority) VALUES($1,'demo','Ruled shop','Groceries',1)",
        [randomUUID()],
      );
      await ingest({ description: "Ruled shop" });
      let calls = 0;
      const make = () =>
        createClassificationIntegration({
          pool,
          store,
          config,
          fetchImpl: async (_url, options) => {
            calls++;
            const body = JSON.parse(options.body);
            assert.equal(body.max_tokens, 150);
            assert.deepEqual(
              Object.keys(JSON.parse(body.messages[1].content)),
              ["description", "categories"],
            );
            return reply();
          },
        });
      const worker = make();
      await worker.init();
      await worker.tick();
      assert.equal(calls, 1);
      assert.equal(
        (await store.getTransaction(wanted.id)).category,
        "Uncategorized",
      );
      assert((await store.listReviews()).some((t) => t.id === wanted.id));
      assert.equal((await worker.suggest(wanted.id)).category, "Groceries");
      await Promise.all([worker.tick(), make().tick()]);
      assert.equal(calls, 1);
      const jobs = (await pool.query("SELECT * FROM classification_jobs")).rows;
      assert.equal(jobs.length, 1);
      assert.equal(jobs[0].origin, "automatic");
      assert.equal(jobs[0].result.requiresReview, true);
    }),
);

test(
  "opt-in automatic application persists independently, follows precedence, and creates budget alerts with dashboard closed",
  { skip: !connectionString },
  async () =>
    fixture(async ({ pool, store, config, ingest }) => {
      config.llmAutoApply = true;
      await store.saveBudget({
        category: "Groceries",
        currency: "AUD",
        month: "2026-09",
        capMinor: "1000",
        allocationMinor: "0",
        rollover: false,
      });
      const tx = await ingest({
        sourceId: "stable",
        description: "Fictional market",
      });
      const worker = createClassificationIntegration({
        pool,
        store,
        config,
        fetchImpl: async () => reply(),
      });
      await worker.init();
      await worker.tick();
      assert.equal((await store.getTransaction(tx.id)).category, "Groceries");
      assert.equal(
        (await pool.query("SELECT * FROM transaction_overrides")).rowCount,
        0,
      );
      assert.equal(
        (
          await pool.query(
            "SELECT * FROM audit_history WHERE action='llm-classification'",
          )
        ).rowCount,
        1,
      );
      assert.equal(
        (
          await pool.query(
            "SELECT * FROM budget_alerts WHERE resolved_at IS NULL",
          )
        ).rowCount,
        1,
      );
      await ingest({ sourceId: "stable", description: "Fictional market" });
      assert.equal((await store.getTransaction(tx.id)).category, "Groceries");
      await ingest({
        sourceId: "stable",
        description: "Fictional market",
        category: "Transport",
      });
      assert.equal((await store.getTransaction(tx.id)).category, "Transport");
      assert.equal(
        (
          await pool.query(
            "SELECT * FROM budget_alerts WHERE resolved_at IS NULL",
          )
        ).rowCount,
        0,
      );
      await store.correctTransaction(tx.id, { category: "Manual" });
      await worker.tick();
      assert.equal((await store.getTransaction(tx.id)).category, "Manual");
    }),
);

test(
  "automatic jobs enforce shared daily cap, retry invalid output, and serialize provider concurrency",
  { skip: !connectionString },
  async () =>
    fixture(async ({ pool, store, config, ingest }) => {
      config.llmDailyRequestLimit = 2;
      config.llmAutoApply = true;
      config.llmBatchSize = 2;
      for (let i = 0; i < 4; i++) await ingest();
      let calls = 0,
        active = 0,
        maximum = 0;
      const make = () =>
        createClassificationIntegration({
          pool,
          store,
          config,
          fetchImpl: async () => {
            calls++;
            maximum = Math.max(maximum, ++active);
            await new Promise((resolve) => setTimeout(resolve, 10));
            active--;
            return reply("Invented unsafe category");
          },
        });
      const a = make(),
        b = make();
      await a.init();
      await Promise.all([a.tick(), b.tick()]);
      await a.tick();
      assert.equal(calls, 2);
      assert.equal(maximum, 1);
      assert.equal(
        (await pool.query("SELECT requests FROM classification_usage")).rows[0]
          .requests,
        2,
      );
      assert(
        (await store.listTransactions()).every(
          (t) => t.category === "Uncategorized" && t.reviewRequired,
        ),
      );
      assert.equal(
        (await pool.query("SELECT * FROM classification_jobs WHERE attempts>0"))
          .rowCount,
        2,
      );
      // Simulate next UTC day's fresh allowance while retaining durable jobs.
      await pool.query("UPDATE classification_usage SET day=day-1");
      await pool.query("UPDATE classification_jobs SET next_attempt_at=now()");
      await a.tick();
      assert.equal(calls, 4);
    }, 4),
);

test(
  "automatic apply rechecks manual changes during mocked provider request",
  { skip: !connectionString },
  async () =>
    fixture(async ({ pool, store, config, ingest }) => {
      config.llmAutoApply = true;
      const tx = await ingest();
      // Independent connection represents a concurrent user's correction, while worker holds its client.
      const other = new pg.Pool({
        connectionString,
        options: pool.options.options,
      });
      const otherStore = new Store(other);
      try {
        const worker = createClassificationIntegration({
          pool,
          store,
          config,
          fetchImpl: async () => {
            await otherStore.correctTransaction(tx.id, { category: "Manual" });
            return reply();
          },
        });
        await worker.init();
        await worker.tick();
        assert.equal((await store.getTransaction(tx.id)).category, "Manual");
        assert.equal(
          (await pool.query("SELECT result FROM classification_jobs")).rows[0]
            .result.requiresReview,
          true,
        );
        assert.equal(
          (
            await pool.query(
              "SELECT * FROM audit_history WHERE action='llm-classification'",
            )
          ).rowCount,
          0,
        );
      } finally {
        await other.end();
      }
    }),
);

test(
  "automatic switch pauses durable jobs and changed source inputs create a fresh deduplicated job",
  { skip: !connectionString },
  async () =>
    fixture(async ({ pool, store, config, ingest }) => {
      config.llmAutoApply = true;
      const tx = await ingest({
        sourceId: "changing",
        description: "Unknown merchant",
      });
      let calls = 0,
        fail = true;
      const worker = createClassificationIntegration({
        pool,
        store,
        config,
        fetchImpl: async () => {
          calls++;
          return fail ? Response.json({}, { status: 503 }) : reply();
        },
      });
      await worker.init();
      await worker.tick();
      assert.equal(calls, 1);
      config.llmAutoClassify = false;
      await pool.query("UPDATE classification_jobs SET next_attempt_at=now()");
      await worker.tick();
      assert.equal(calls, 1);
      config.llmAutoClassify = true;
      fail = false;
      await worker.tick();
      assert.equal(calls, 2);
      assert.equal((await store.getTransaction(tx.id)).category, "Groceries");
      await ingest({
        sourceId: "changing",
        description: "Unknown merchant",
        amountMinor: "-3500",
      });
      assert.equal(
        (await store.getTransaction(tx.id)).category,
        "Uncategorized",
      );
      await worker.tick();
      assert.equal(calls, 3);
      assert.equal((await store.getTransaction(tx.id)).category, "Groceries");
      assert.equal(
        (await pool.query("SELECT * FROM classification_jobs")).rowCount,
        2,
      );
    }),
);
