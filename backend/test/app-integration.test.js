import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { randomUUID, randomBytes } from "node:crypto";
import { Store } from "../src/store.js";
import { createApp } from "../src/app.js";
import { createHouseholdAuth } from "../src/household-auth.js";
test(
  "live provider outage leaves imported data, corrections, budgets and exports usable",
  { skip: !process.env.DATABASE_URL },
  async (t) => {
    const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    const schema = "app_" + randomUUID().replaceAll("-", "");
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    t.after(async () => {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    });
    const store = new Store(pool, { mode: "live" });
    await store.migrate();
    const tx = await store.ingest({
      mode: "live",
      sourceId: "txn_test",
      accountId: "acc_test",
      amountMinor: "-1250",
      currency: "AUD",
      status: "posted",
      date: "2026-09-15",
      description: "Fictional grocer",
      category: "Groceries",
    });
    const config = {
      mode: "live",
      origin: "https://profe.test",
      port: 0,
      host: "127.0.0.1",
      currency: "AUD",
      timezone: "Australia/Brisbane",
      bootstrapToken: randomBytes(32).toString("base64"),
      sessionSecret: "s".repeat(32),
    };
    const integration = {
      testConnection: async () => {
        throw Object.assign(Error("provider_unreachable"), { status: 502 });
      },
      status: async () => ({
        configured: true,
        verified: false,
        lastError: "provider_unreachable",
      }),
    };
    const auth = createHouseholdAuth({ pool, config });
    await auth.init();
    await auth.bootstrap(
      { headers: {}, socket: { remoteAddress: "127.0.0.1" } },
      {
        email: "admin@example.test",
        name: "Fictional admin",
        password: "fictional password",
        bootstrapToken: config.bootstrapToken,
      },
    );
    const app = createApp({ store, integration, config, auth });
    const server = await new Promise((resolve) => {
      const s = app.start(() => resolve(s));
    });
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const url = `http://127.0.0.1:${server.address().port}`;
    const login = await fetch(url + "/api/login", {
      method: "POST",
      headers: { Origin: config.origin },
      body: JSON.stringify({
        email: "admin@example.test",
        password: "fictional password",
      }),
    });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const request = (path, method = "GET", value) =>
      fetch(url + path, {
        method,
        headers: {
          Cookie: cookie,
          Origin: config.origin,
          "Content-Type": "application/json",
        },
        ...(value ? { body: JSON.stringify(value) } : {}),
      });
    assert.equal(
      (await request("/api/connection/test", "POST", {})).status,
      502,
    );
    assert.equal(
      (await request("/api/transactions?month=2026-09")).status,
      200,
    );
    const changed = await request(`/api/transactions/${tx.id}`, "PATCH", {
      category: "Food",
      splits: [],
    });
    assert.equal(changed.status, 200, await changed.text());
    const saved = await request("/api/budgets", "PUT", {
      month: "2026-09",
      currency: "AUD",
      category: "Food",
      capMinor: "1000",
    });
    assert.equal(saved.status, 200);
    const report = await (await request("/api/dashboard?month=2026-09")).json();
    assert.equal(report.expensesMinor, "1250");
    assert.equal(report.budgets[0].overspent, true);
    const exported = await (await request("/api/export?month=2026-09")).json();
    assert.equal(exported.summary.expensesMinor, report.expensesMinor);
    assert.equal(exported.transactions[0].category, "Food");
    const emptyExport = await (
      await request("/api/export?month=2026-09&ids=")
    ).json();
    assert.equal(emptyExport.transactions.length, 0);
    assert.equal(emptyExport.selectionSummary.expensesMinor, "0");
    assert.equal(emptyExport.summary.expensesMinor, "1250");
    const invalid = await request(`/api/transactions/${tx.id}`, "PATCH", {
      splits: [{ category: "Food", amountMinor: "-1249" }],
    });
    assert.equal(invalid.status, 400);
    assert.equal((await store.getTransaction(tx.id)).category, "Food");
  },
);
