import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { Store } from "../src/store.js";
import { createSettingsStore } from "../src/settings.js";
import { createHouseholdAuth } from "../src/household-auth.js";
import { createSimplefinIntegration } from "../src/simplefin.js";
import { createApp } from "../src/app.js";
import { SimplefinClient } from "../src/simplefin-client.js";
const connectionString = process.env.TEST_DATABASE_URL;
async function fixture(t) {
  const root = new pg.Pool({ connectionString });
  const schema = `sf_parent_${randomUUID().replaceAll("-", "")}`;
  await root.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({
    connectionString,
    options: `-c search_path=${schema}`,
  });
  const config = {
    mode: "live",
    appSecret: randomBytes(32).toString("base64"),
    origin: "https://dolphino.test",
    host: "127.0.0.1",
    port: 0,
    timezone: "Etc/UTC",
  };
  const store = new Store(pool, { mode: "live", timezone: "Etc/UTC" });
  await store.migrate();
  const settings = createSettingsStore({ pool, appSecret: config.appSecret });
  await settings.init();
  const auth = createHouseholdAuth({ pool, config });
  await auth.init();
  const cookies = {};
  for (const role of ["admin", "member"]) {
    const id = (
      await pool.query(
        "INSERT INTO household_users(email,name,role,password_hash) VALUES($1,$2,$2,'synthetic-unused') RETURNING id",
        [`${role}@example.test`, role],
      )
    ).rows[0].id;
    const token = randomBytes(32).toString("base64url");
    await pool.query(
      "INSERT INTO household_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",
      [createHash("sha256").update(token).digest("hex"), id],
    );
    cookies[role] = `dolphino_session=${token}`;
  }
  const access =
    "https://synthetic-client:independent-synthetic-secret@provider.example.com/simplefin";
  let calls = 0;
  let hook;
  const simplefin = createSimplefinIntegration({
    pool,
    store,
    settings,
    config,
    request: async (url, opts) => {
      calls++;
      if (hook) await hook(url, opts);
      return opts?.method === "POST"
        ? { status: 200, body: access }
        : { status: 200, body: JSON.stringify({ errors: [], accounts: [] }) };
    },
  });
  await simplefin.init();
  const app = createApp({ store, settings, config, auth, simplefin });
  const server = await new Promise((resolve) => {
    const s = app.start(() => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(
    path,
    { method = "GET", value, role = "admin", origin = config.origin } = {},
  ) {
    const r = await fetch(base + "/api/settings/simplefin" + path, {
      method,
      headers: {
        ...(cookies[role] ? { Cookie: cookies[role] } : {}),
        ...(origin === null ? {} : { Origin: origin }),
        "Content-Type": "application/json",
      },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    });
    const text = await r.text();
    return { status: r.status, text, json: JSON.parse(text) };
  }
  t.after(async () => {
    await simplefin.stop();
    await new Promise((r) => server.close(r));
    await pool.end();
    await root.query(`DROP SCHEMA ${schema} CASCADE`);
    await root.end();
  });
  return {
    pool,
    request,
    calls: () => calls,
    setHook: (v) => {
      hook = v;
    },
    token: (id) =>
      Buffer.from(
        `https://provider.example.com/simplefin/claim/${id}`,
      ).toString("base64"),
  };
}
test(
  "Independent SimpleFIN HTTP permissions derive real PostgreSQL sessions and deny every administrative route",
  { skip: !connectionString },
  async (t) => {
    const f = await fixture(t);
    const routes = [
      ["", "GET"],
      ["", "PUT"],
      ...["connect", "disconnect", "test", "map", "backfill"].map((p) => [
        "/" + p,
        "POST",
      ]),
    ];
    let denied = 0;
    for (const [path, method] of routes) {
      for (const role of ["anonymous", "member"]) {
        const r = await f.request(path, {
          method,
          role,
          value: method === "GET" ? undefined : {},
        });
        assert.equal(r.status, role === "anonymous" ? 401 : 403);
        denied++;
      }
      if (method !== "GET")
        for (const origin of [
          null,
          "null",
          "https://evil.test",
          "https://dolphino.test.evil.test",
        ]) {
          const r = await f.request(path, { method, origin, value: {} });
          assert.equal(r.status, 403);
          denied++;
        }
    }
    assert.equal(f.calls(), 0);
    assert.equal((await f.request("")).status, 200);
    t.diagnostic(
      `${denied} unauthorized requests denied with zero provider calls`,
    );
  },
);
test(
  "Independent concurrent SimpleFIN claims consume once and never reveal access secrets",
  { skip: !connectionString },
  async (t) => {
    const f = await fixture(t);
    f.setHook(async (_u, o) => {
      if (o?.method === "POST") await new Promise((r) => setTimeout(r, 30));
    });
    const token = f.token("one-time-independent");
    const pair = await Promise.all(
      [1, 2].map(() =>
        f.request("/connect", {
          method: "POST",
          value: { token, acknowledgeAccess: true },
        }),
      ),
    );
    assert.deepEqual(pair.map((x) => x.status).sort(), [200, 409]);
    assert.equal(f.calls(), 1);
    const status = await f.request("");
    assert(!status.text.includes("independent-synthetic-secret"));
    assert(!status.text.includes(token));
    const credentials = (
      await f.pool.query(
        "SELECT * FROM encrypted_credentials WHERE setting='simplefin.accessUrl'",
      )
    ).rows;
    assert.equal(credentials.length, 1);
    assert(
      !JSON.stringify(credentials).includes("independent-synthetic-secret"),
    );
    assert.equal(
      (
        await f.request("/disconnect", {
          method: "POST",
          value: { confirm: true },
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await f.request("/connect", {
          method: "POST",
          value: { token, acknowledgeAccess: true },
        })
      ).status,
      409,
    );
    assert.equal(f.calls(), 1);
  },
);
test("Independent provider error sanitization cannot erase incomplete-data evidence", async () => {
  const client = new SimplefinClient(
    "https://synthetic:secret@provider.example.com/simplefin",
    {
      request: async () => ({
        status: 200,
        body: JSON.stringify({
          errors: ["<br>"],
          accounts: [
            {
              org: { domain: "bank.example.com" },
              id: "one",
              name: "Test",
              currency: "AUD",
              balance: "1.00",
              "balance-date": 1767225600,
              errors: ["\u0001"],
              transactions: [],
            },
          ],
        }),
      }),
    },
  );
  const data = await client.accounts();
  assert.equal(data.errors.length, 1);
  assert.equal(data.accounts[0].errors.length, 1);
  assert(data.errors[0].length > 0);
  assert(data.accounts[0].errors[0].length > 0);
});
