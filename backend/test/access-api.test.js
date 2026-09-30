import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { Store } from "../src/store.js";
import { createHouseholdAuth } from "../src/household-auth.js";
import { createApp } from "../src/app.js";
import { validateAndSetGrants } from "../src/access.js";
const connectionString =
  process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
test(
  "HTTP financial scopes isolate disjoint users, aggregate-only budgets and guessed IDs",
  { skip: !connectionString },
  async () => {
    const admin = new pg.Pool({ connectionString }),
      schema = `access_api_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString,
      options: `-c search_path=${schema}`,
    });
    let server;
    try {
      const store = new Store(pool, { mode: "live" });
      await store.migrate();
      const config = {
        mode: "live",
        host: "127.0.0.1",
        port: 0,
        origin: "https://dolphino.test",
        currency: "AUD",
        timezone: "Australia/Brisbane",
        bootstrapToken: randomBytes(32).toString("base64"),
      };
      const auth = createHouseholdAuth({ pool, config });
      await auth.init();
      const req = { headers: {}, socket: { remoteAddress: "test" } };
      const password = "synthetic household password";
      const root = await auth.bootstrap(req, {
        email: "admin@example.test",
        name: "Admin",
        password,
        bootstrapToken: config.bootstrapToken,
      });
      const users = {};
      for (const name of ["alice", "bob", "budget", "none"]) {
        users[name] = (
          await pool.query(
            "INSERT INTO household_users(email,name,role,password_hash) SELECT $1,$2,'member',password_hash FROM household_users WHERE id=$3 RETURNING id",
            [`${name}@example.test`, name, root.user.id],
          )
        ).rows[0].id;
      }
      const baseTx = {
        currency: "AUD",
        amountMinor: "-1000",
        status: "posted",
        date: "2026-09-01",
        category: "Groceries",
        kind: "expense",
      };
      const a = await store.ingest({
        ...baseTx,
        sourceId: "a",
        accountId: "acct_a",
        description: "Alice private merchant",
      });
      const b = await store.ingest({
        ...baseTx,
        sourceId: "b",
        accountId: "acct_b",
        amountMinor: "-2000",
        description: "Bob secret merchant",
        category: "Secret category",
      });
      const transfer = await store.ingest({
        ...baseTx,
        sourceId: "transfer",
        accountId: "acct_a",
        amountMinor: "-5000",
        kind: "transfer",
        description: "Bob secret repayment",
        category: "Private transfer category",
      });
      await store.correctTransaction(transfer.id, {
        note: "Bob confidential transfer note",
      });
      const budget = await store.saveBudget({
        currency: "AUD",
        month: "2026-09",
        category: "Groceries",
        capMinor: "500",
      });
      const hiddenBudget = await store.saveBudget({
        currency: "AUD",
        month: "2026-09",
        category: "Secret category",
        capMinor: "100",
      });
      const grant = async (name, value) =>
        store.atomic(
          (c) => validateAndSetGrants(c, users[name], value, { mode: "live" }),
          { refresh: false },
        );
      await grant("alice", {
        accounts: [{ accountId: "acct_a", access: "view" }],
      });
      await grant("bob", {
        accounts: [{ accountId: "acct_b", access: "edit" }],
      });
      await grant("budget", {
        budgets: [{ budgetId: budget.id, access: "view" }],
      });
      const app = createApp({
        store,
        config,
        auth,
        integration: {},
        classification: {
          suggest: async () => {
            throw Error("unauthorized provider call");
          },
        },
      });
      server = await new Promise((resolve) => {
        const s = app.start(() => resolve(s));
      });
      const url = `http://127.0.0.1:${server.address().port}`;
      const cookies = { admin: root.cookie.split(";")[0] };
      for (const name of Object.keys(users)) {
        const logged = await auth.login(req, {
          email: `${name}@example.test`,
          password,
        });
        cookies[name] = logged.cookie.split(";")[0];
      }
      const request = (name, path, method = "GET", value) =>
        fetch(url + path, {
          method,
          headers: { Cookie: cookies[name], Origin: config.origin },
          ...(value === undefined ? {} : { body: JSON.stringify(value) }),
        });
      const json = async (name, path) => {
        const response = await request(name, path);
        assert.equal(response.status, 200, await response.clone().text());
        return response.json();
      };
      assert.equal((await json("admin", "/api/accounts")).accounts.length, 2);
      for (const [name, accountId, total] of [
        ["alice", "acct_a", "1000"],
        ["bob", "acct_b", "2000"],
      ]) {
        assert.deepEqual(
          (await json(name, "/api/accounts")).accounts.map((a) => a.id),
          [accountId],
        );
        const report = await json(
          name,
          "/api/dashboard?month=2026-09&months=2",
        );
        assert.equal(report.expensesMinor, total);
        assert.equal(report.accounts.length, 1);
        assert.equal(report.budgets.length, 0);
        const exported = await json(name, "/api/export?month=2026-09&months=2");
        assert.equal(exported.summary.expensesMinor, total);
        assert.ok(
          exported.transactions.every((tx) => tx.accountId === accountId),
        );
      }
      const aliceExport = await json("alice", "/api/export?allHistory=true");
      assert.ok(!JSON.stringify(aliceExport).includes("Bob"));
      assert.ok(!JSON.stringify(aliceExport).includes("Secret category"));
      assert.ok(
        !JSON.stringify(aliceExport).includes("Private transfer category"),
      );
      assert.equal(
        (await json("alice", "/api/transactions?allHistory=true&search=Bob"))
          .total,
        0,
      );
      assert.equal(
        (await json("alice", `/api/transactions?ids=${b.id}`)).total,
        0,
      );
      assert.equal(
        (
          await request(
            "alice",
            "/api/transactions?accountId=acct_b&allHistory=true",
          )
        ).status,
        404,
      );
      for (const path of [
        `/api/transactions/${b.id}/audit`,
        `/api/transactions/${b.id}/suggest`,
      ])
        assert.equal(
          (
            await request(
              "alice",
              path,
              path.endsWith("suggest") ? "POST" : "GET",
              path.endsWith("suggest") ? {} : undefined,
            )
          ).status,
          path.endsWith("suggest") ? 403 : 404,
        );
      assert.equal(
        (
          await request("alice", `/api/transactions/${a.id}`, "PATCH", {
            category: "Changed",
          })
        ).status,
        404,
      );
      assert.equal(
        (
          await request("bob", `/api/transactions/${b.id}`, "PATCH", {
            category: "Bob corrected",
          })
        ).status,
        200,
      );
      assert.equal(
        (await store.getTransaction(b.id)).category,
        "Bob corrected",
      );
      assert.deepEqual(
        (await json("alice", `/api/transactions/${transfer.id}/audit`)).audit,
        [],
      );
      const budgetReport = await json("budget", "/api/dashboard?month=2026-09");
      assert.equal(budgetReport.expensesMinor, "0");
      assert.equal(budgetReport.budgets.length, 1);
      assert.equal(budgetReport.budgets[0].spentMinor, "1000");
      assert.deepEqual(budgetReport.budgets[0].transactionIds, []);
      assert.deepEqual(budgetReport.accounts, []);
      assert.equal(
        (await json("budget", "/api/transactions?allHistory=true")).total,
        0,
      );
      assert.equal(
        (await json("budget", "/api/export?allHistory=true")).transactions
          .length,
        0,
      );
      assert.equal(
        (
          await request("budget", "/api/budgets", "PUT", {
            currency: "AUD",
            month: "2026-09",
            category: "Groceries",
            capMinor: "800",
          })
        ).status,
        404,
      );
      await grant("budget", {
        budgets: [{ budgetId: budget.id, access: "edit" }],
      });
      assert.equal(
        (
          await request("budget", "/api/budgets", "PUT", {
            currency: "AUD",
            month: "2026-09",
            category: "Groceries",
            capMinor: "800",
          })
        ).status,
        200,
      );
      assert.equal(
        (await request("budget", `/api/budgets/${hiddenBudget.id}`, "DELETE"))
          .status,
        404,
      );
      for (const name of Object.keys(users))
        for (const path of [
          "/api/settings/provider",
          "/api/users",
          "/api/rules",
        ])
          assert.equal(
            (await request(name, path)).status,
            403,
            `${name} ${path}`,
          );
      assert.equal(
        (await json("none", "/api/dashboard?month=2026-09")).expensesMinor,
        "0",
      );
      assert.equal(
        (await json("none", "/api/transactions?allHistory=true")).total,
        0,
      );
      await grant("bob", {});
      assert.equal(
        (await json("bob", "/api/transactions?allHistory=true")).total,
        0,
      );
      assert.equal(
        (
          await request("bob", `/api/transactions/${b.id}`, "PATCH", {
            category: "stale grant",
          })
        ).status,
        404,
      );
    } finally {
      if (server) await new Promise((resolve) => server.close(resolve));
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
