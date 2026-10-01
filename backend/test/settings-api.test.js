import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { randomUUID, randomBytes } from "node:crypto";
import { Store } from "../src/store.js";
import { createSettingsStore } from "../src/settings.js";
import { createApp } from "../src/app.js";
import { createHouseholdAuth } from "../src/household-auth.js";
test(
  "authenticated settings enforce origin, write-only secrets, explicit model cost consent and rate limits",
  { skip: !process.env.DATABASE_URL },
  async (t) => {
    const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    const schema = "settings_api_" + randomUUID().replaceAll("-", "");
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
    const config = {
      mode: "live",
      origin: "https://dolphino.test",
      port: 0,
      host: "127.0.0.1",
      bootstrapToken: randomBytes(32).toString("base64"),
      sessionSecret: randomBytes(32).toString("hex"),
      currency: "AUD",
      timezone: "Australia/Brisbane",
    };
    const store = new Store(pool, { mode: "live" });
    await store.migrate();
    const settings = createSettingsStore({
      pool,
      appSecret: randomBytes(32).toString("base64"),
      envConfig: config,
    });
    await settings.init();
    let modelCalls = 0,
      listCalls = 0;
    const auth = createHouseholdAuth({ pool, config });
    await auth.init();
    await auth.bootstrap(
      { headers: {}, socket: { remoteAddress: "127.0.0.1" } },
      {
        email: "admin@example.test",
        name: "Fictional admin",
        password: "synthetic-password",
        bootstrapToken: config.bootstrapToken,
      },
    );
    const app = createApp({
      auth,
      store,
      config,
      settings,
      integration: { status: async () => ({ configured: false }) },
      registration: { status: async () => ({ state: "not_registered" }) },
      providerDependencies: {
        fetchImpl: async (url) => {
          if (String(url).includes("/models")) {
            listCalls++;
            return new Response(JSON.stringify({ data: [] }));
          }
          modelCalls++;
          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      category: "Groceries",
                      reason: "Synthetic",
                    }),
                  },
                },
              ],
            }),
          );
        },
      },
    });
    const server = await new Promise((resolve) => {
      const s = app.start(() => resolve(s));
    });
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(base + "/api/settings/provider")).status, 401);
    const login = await fetch(base + "/api/login", {
      method: "POST",
      headers: { Origin: config.origin },
      body: JSON.stringify({
        email: "admin@example.test",
        password: "synthetic-password",
      }),
    });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const req = (path, method = "GET", value, origin = config.origin) =>
      fetch(base + path, {
        method,
        headers: { Cookie: cookie, Origin: origin },
        ...(value === undefined ? {} : { body: JSON.stringify(value) }),
      });
    const value = {
      provider: "openai",
      model: "synthetic-model",
      apiKey: "synthetic-secret-never-return",
      enabled: false,
    };
    assert.equal(
      (await req("/api/settings/provider", "PUT", value, "https://wrong.test"))
        .status,
      403,
    );
    const saved = await req("/api/settings/provider", "PUT", value);
    assert.equal(saved.status, 200);
    assert(!JSON.stringify(await saved.json()).includes(value.apiKey));
    assert.equal(
      (await req("/api/settings/provider/test-connection", "POST", {})).status,
      200,
    );
    assert.equal(listCalls, 1);
    assert.equal(modelCalls, 0);
    assert.equal(
      (await req("/api/settings/provider/test-model", "POST", {})).status,
      400,
    );
    assert.equal(modelCalls, 0);
    const inference = await req("/api/settings/provider/test-model", "POST", {
      acknowledgeCost: true,
    });
    assert.equal(inference.status, 200, await inference.text());
    assert.equal(modelCalls, 1);
    for (let i = 0; i < 4; i++)
      await req("/api/settings/provider/test-connection", "POST", {});
    assert.equal(
      (await req("/api/settings/provider/test-connection", "POST", {})).status,
      429,
    );
    assert(
      !JSON.stringify(
        await (await req("/api/settings/provider")).json(),
      ).includes(value.apiKey),
    );
  },
);
