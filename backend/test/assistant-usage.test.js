import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { createAssistantUsage } from "../src/assistant-usage.js";
const connectionString =
  process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
test(
  "durable per-user assistant quota is atomic across workers and UTC rollover",
  { skip: !connectionString },
  async () => {
    const admin = new pg.Pool({ connectionString }),
      schema = `assistant_usage_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString,
      options: `-c search_path=${schema}`,
    });
    try {
      let now = Date.parse("2026-09-30T23:59:59Z");
      const usage = createAssistantUsage({ pool, now: () => now });
      await usage.init();
      const results = await Promise.allSettled(
        Array.from({ length: 10 }, () =>
          usage.reserveRequest({ userId: "synthetic-user", limit: 3 }),
        ),
      );
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 3);
      const restarted = createAssistantUsage({ pool, now: () => now });
      await assert.rejects(
        restarted.reserveRequest({ userId: "synthetic-user", limit: 3 }),
        /Daily/,
      );
      await restarted.reserveRequest({ userId: "other-user", limit: 3 });
      now += 2000;
      assert.equal(
        (await restarted.reserveRequest({ userId: "synthetic-user", limit: 3 }))
          .requests,
        1,
      );
      assert.deepEqual(
        Object.keys(
          (await pool.query("SELECT * FROM assistant_usage LIMIT 1")).rows[0],
        ).sort(),
        ["requests", "usage_day", "user_id"],
      );
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
