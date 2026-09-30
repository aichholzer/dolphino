import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import pg from "pg";
import { Store } from "../src/store.js";
const connectionString =
  process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
test(
  "review decisions survive unchanged polling; changed evidence and identity warnings remain reviewable",
  { skip: !connectionString },
  async () => {
    const admin = new pg.Pool({ connectionString });
    const schema = `review_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString,
      options: `-c search_path=${schema}`,
    });
    const store = new Store(pool, { mode: "live" });
    try {
      await store.migrate();
      const observation = {
        sourceId: "review",
        accountId: "account",
        currency: "AUD",
        amountMinor: "-100",
        status: "posted",
        date: "2026-09-01",
        description: "Fictional shop",
        kind: "expense",
        reviewReason: "Classification review: ambiguous provider evidence",
        fetchedAt: "2026-09-01T00:00:00Z",
      };
      const tx = await store.ingest(observation);
      await store.resolveReview(tx.id);
      await store.ingest({ ...observation, fetchedAt: "2026-09-02T00:00:00Z" });
      assert.equal((await store.getTransaction(tx.id)).reviewRequired, false);
      await store.ingest({
        ...observation,
        amountMinor: "-200",
        fetchedAt: "2026-09-03T00:00:00Z",
      });
      assert.equal((await store.getTransaction(tx.id)).reviewRequired, true);
      await store.correctTransaction(tx.id, { category: "Groceries" });
      await store.ingest({
        ...observation,
        amountMinor: "-200",
        fetchedAt: "2026-09-04T00:00:00Z",
      });
      assert.equal((await store.getTransaction(tx.id)).reviewRequired, false);
      const second = await store.ingest({ ...observation, sourceId: "second" });
      await store.saveRule({
        contains: "Fictional shop",
        category: "Shopping",
      });
      assert.equal(
        (await store.getTransaction(second.id)).reviewRequired,
        true,
        "a category-only rule does not settle ambiguous financial kind",
      );
      await store.saveRule({
        contains: "Fictional shop",
        category: "Shopping",
        kind: "expense",
      });
      assert.equal(
        (await store.getTransaction(second.id)).reviewRequired,
        false,
      );
      await pool.query(
        "UPDATE transactions SET review_reason='Possible pending replacement: review source identity' WHERE id=$1",
        [second.id],
      );
      await store.ingest({
        ...observation,
        sourceId: "second",
        fetchedAt: "2026-09-05T00:00:00Z",
      });
      assert.match(
        (await store.getTransaction(second.id)).reviewReason,
        /identity/,
      );
      // pg DATE values are local midnight: exercise a real query in a non-UTC process.
      const result = execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import pg from 'pg'; import {Store} from './backend/src/store.js'; const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,options:'-c search_path=${schema}'}); const tx=await new Store(pool,{mode:'live'}).getTransaction('${tx.id}'); console.log(tx.date); await pool.end();`,
        ],
        {
          cwd: new URL("../../", import.meta.url),
          env: {
            ...process.env,
            TZ: "Australia/Brisbane",
            TEST_DATABASE_URL: connectionString,
          },
          encoding: "utf8",
        },
      );
      assert.equal(result.trim(), "2026-09-01");
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
