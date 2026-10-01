import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { randomBytes, randomUUID, createHash, createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import { Store } from "../src/store.js";
import { createApp } from "../src/app.js";
import { createHouseholdAuth } from "../src/household-auth.js";
import { createSettingsStore } from "../src/settings.js";
import { createRedbarkSettings } from "../src/redbark-settings.js";
import { createAssistantSettings } from "../src/assistant-settings.js";
import { createRedbarkIntegration } from "../src/worker.js";
import { createClassificationIntegration } from "../src/classification.js";
import { createRegistration } from "../src/registration.js";
import { readConfig } from "../src/config.js";
import { validateAndSetGrants } from "../src/access.js";
import { STSClient } from "@aws-sdk/client-sts";
import { BedrockClient } from "@aws-sdk/client-bedrock";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";

// These tests use actual TCP HTTP and PostgreSQL. Outbound provider I/O is
// exclusively mocked at the supported dependency boundary, with calls recorded.
const connectionString =
  process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const baseProvider = {
  provider: "openai",
  model: "synthetic-model",
  enabled: true,
  autoClassify: false,
  autoApply: false,
  dailyRequestLimit: 12,
  batchSize: 3,
};
const secrets = {
  redbark: "synthetic-redbark-api-A",
  signing: "synthetic-redbark-signing-A",
  provider: "synthetic-classifier-api-A",
  assistant: "synthetic-assistant-api-A",
};
const signature = (raw, secret) => {
  const timestamp = Math.floor(Date.now() / 1000);
  return `t=${timestamp},v1=${createHmac("sha256", secret).update(`${timestamp}.`).update(raw).digest("hex")}`;
};
async function fixture(t) {
  const admin = new pg.Pool({
    connectionString,
    connectionTimeoutMillis: 1000,
  });
  const schema = `adversarial_http_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({
    connectionString,
    options: `-c search_path=${schema}`,
    connectionTimeoutMillis: 1000,
  });
  const dbErrors = [];
  pool.on("error", (e) => dbErrors.push(e.code));
  admin.on("error", (e) => dbErrors.push(e.code));
  const appSecret = randomBytes(32).toString("base64");
  const config = {
    mode: "live",
    origin: "https://dolphino.test",
    port: 0,
    host: "127.0.0.1",
    currency: "AUD",
    timezone: "Etc/UTC",
    appSecret,
    redbarkApiKey: "ENV-MUST-NOT-BE-USED",
    llmApiKey: "ENV-MUST-NOT-BE-USED",
    llmEnabled: true,
    llmBaseUrl: "http://127.0.0.1/secret",
  };
  const store = new Store(pool, { mode: "live" });
  await store.migrate();
  const settings = createSettingsStore({
    pool,
    appSecret,
    envConfig: config,
    allowEnvironmentFallback: true,
  });
  await settings.init();
  const redbark = createRedbarkSettings({ pool, settings, appSecret });
  const assistantSettings = createAssistantSettings({ pool, appSecret });
  const outbound = [],
    remote = [];
  let hook;
  const fetchImpl = async (url, options = {}) => {
    outbound.push({
      url: String(url),
      headers: structuredClone(options.headers || {}),
      body: options.body,
      redirect: options.redirect,
    });
    if (hook) {
      const result = await hook(String(url), options);
      if (result) return result;
    }
    if (String(url).includes("api.redbark.com"))
      return Response.json({ data: [], next_page_url: null });
    if (String(url).includes("/models/"))
      return Response.json({ id: "synthetic-model" });
    return Response.json({
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
    });
  };
  const integration = createRedbarkIntegration({
    pool,
    store,
    config,
    getRedbarkConfig: redbark.getRuntimeConfig,
    fetchImpl,
  });
  await integration.init();
  const classification = createClassificationIntegration({
    pool,
    store,
    config,
    getProviderConfig: settings.getProviderConfig,
    fetchImpl,
  });
  await classification.init();
  const destination = {
    id: "ed_Synthetic",
    status: "enabled",
    webhook_endpoint: {
      url: "https://finance.dolphino.app/api/webhooks/redbark",
      signing_secret: "synthetic-remote-signing-secret",
    },
  };
  const registration = createRegistration({
    pool,
    settings,
    config,
    getRedbarkConfig: redbark.getRuntimeConfig,
    lookupImpl: async () => [{ address: "93.184.216.34" }],
    client: {
      list: async (path) => {
        remote.push({ path });
        return [destination];
      },
      request: async (path, options) => {
        remote.push({ path, options });
        return {
          body: path.endsWith("/ping")
            ? { id: "evt_SyntheticPing" }
            : destination,
        };
      },
    },
  });
  await registration.init();
  const auth = createHouseholdAuth({ pool, config });
  await auth.init();
  const cookies = {},
    users = {};
  for (const role of ["admin", "member"]) {
    users[role] = (
      await pool.query(
        "INSERT INTO household_users(email,name,role,password_hash) VALUES($1,$2,$2,'not-used-in-this-test') RETURNING id",
        [`${role}@example.test`, role],
      )
    ).rows[0].id;
    const token = randomBytes(32).toString("base64url");
    await pool.query(
      "INSERT INTO household_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",
      [createHash("sha256").update(token).digest("hex"), users[role]],
    );
    cookies[role] = `dolphino_session=${token}`;
  }
  const servers = [],
    transcript = [];
  async function serve(overrides = {}) {
    const app = createApp({
      store,
      config,
      settings,
      redbarkSettings: redbark,
      assistantSettings,
      auth,
      integration,
      classification,
      registration,
      providerDependencies: { fetchImpl },
      ...overrides,
    });
    const server = await new Promise((resolve) => {
      const s = app.start(() => resolve(s));
    });
    servers.push(server);
    const url = `http://127.0.0.1:${server.address().port}`;
    return async (
      path,
      {
        method = "GET",
        value,
        who = "admin",
        origin = config.origin,
        headers = {},
      } = {},
    ) => {
      const r = await fetch(url + path, {
        method,
        headers: {
          ...(cookies[who] ? { Cookie: cookies[who] } : {}),
          ...(origin === null ? {} : { Origin: origin }),
          ...headers,
        },
        ...(value === undefined
          ? {}
          : {
              body: typeof value === "string" ? value : JSON.stringify(value),
            }),
      });
      const text = await r.text();
      transcript.push({ method, path, who, origin, status: r.status, text });
      return { status: r.status, text, json: text ? JSON.parse(text) : null };
    };
  }
  const request = await serve();
  t.after(async () => {
    await Promise.all(
      servers.map((server) => new Promise((resolve) => server.close(resolve))),
    );
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });
  return {
    pool,
    appSecret,
    settings,
    redbark,
    assistantSettings,
    integration,
    registration,
    classification,
    store,
    config,
    outbound,
    remote,
    request,
    serve,
    users,
    transcript,
    dbErrors,
    setHook: (v) => {
      hook = v;
    },
  };
}
const dbTest = (name, fn) =>
  test(name, { skip: !connectionString, timeout: 30000 }, fn);

dbTest(
  "adversarial live HTTP: every settings route rejects anonymous/member and forged/missing origins",
  async (t) => {
    const f = await fixture(t);
    const routes = [
      ["/api/settings", "GET"],
      ["/api/settings/redbark", "GET"],
      ["/api/settings/redbark", "PUT"],
      ["/api/settings/provider", "GET"],
      ["/api/settings/provider", "PUT"],
      ["/api/settings/provider/test-connection", "POST"],
      ["/api/settings/provider/test-model", "POST"],
      ["/api/settings/assistant", "GET"],
      ["/api/settings/assistant", "PUT"],
      ["/api/settings/assistant/test-connection", "POST"],
      ["/api/settings/assistant/test-model", "POST"],
      ["/api/settings/webhook", "GET"],
      ["/api/settings/webhook/register", "POST"],
      ["/api/settings/webhook/test", "POST"],
      ["/api/connection/test", "POST"],
    ];
    for (const [path, method] of routes) {
      for (const [who, status] of [
        ["anonymous", 401],
        ["member", 403],
      ])
        assert.equal(
          (
            await f.request(path, {
              method,
              who,
              value: method === "GET" ? undefined : {},
            })
          ).status,
          status,
          `${who} ${method} ${path}`,
        );
      if (method !== "GET")
        for (const origin of [
          null,
          "null",
          "https://attacker.test",
          "https://dolphino.test.attacker.test",
        ])
          assert.equal(
            (await f.request(path, { method, value: {}, origin })).status,
            403,
            `${origin} ${path}`,
          );
    }
    assert.equal(f.outbound.length, 0);
    assert.equal(f.remote.length, 0);
    t.diagnostic(
      `${f.transcript.length} actual HTTP authorization/origin probes; outbound=0`,
    );
  },
);

dbTest(
  "adversarial live HTTP: database-only config, write-only credentials, strict endpoint rejection and sanitized provider failures",
  async (t) => {
    const f = await fixture(t);
    for (const kind of ["provider", "assistant", "redbark"])
      assert.equal(
        (await f.request(`/api/settings/${kind}`)).json.configured,
        false,
      );
    assert.equal(
      (await f.request("/api/connection/test", { method: "POST", value: {} }))
        .status,
      409,
    );
    assert.equal(
      (
        await f.request("/api/settings/provider/test-connection", {
          method: "POST",
          value: {},
        })
      ).status,
      409,
    );
    assert.equal(f.outbound.length, 0);
    const ignored = readConfig({
      DATABASE_URL: connectionString,
      DOLPHINO_MODE: "live",
      APP_ORIGIN: "https://dolphino.test",
      LLM_API_KEY_FILE: "/does/not/exist",
      REDBARK_API_KEY_FILE: "/does/not/exist",
      REDBARK_WEBHOOK_SECRET_FILE: "/does/not/exist",
      AWS_SECRET_ACCESS_KEY_FILE: "/does/not/exist",
      AWS_ENDPOINT_URL: "http://127.0.0.1/",
    });
    assert.equal(ignored.llmApiKey, undefined);
    assert.equal(ignored.redbarkApiKey, undefined);
    for (const [kind, value] of [
      ["provider", { ...baseProvider, apiKey: secrets.provider }],
      [
        "assistant",
        {
          provider: "openai",
          model: "synthetic-assistant",
          enabled: true,
          dataSharingAcknowledged: true,
          apiKey: secrets.assistant,
        },
      ],
      ["redbark", { apiKey: secrets.redbark, signingSecret: secrets.signing }],
    ]) {
      assert.equal(
        (await f.request(`/api/settings/${kind}`, { method: "PUT", value }))
          .status,
        200,
      );
      for (const field of ["baseUrl", "endpoint"])
        assert.equal(
          (
            await f.request(`/api/settings/${kind}`, {
              method: "PUT",
              value: {
                ...value,
                [field]: "http://169.254.169.254/latest/meta-data",
              },
            })
          ).status,
          400,
        );
      const response = await f.request(`/api/settings/${kind}`);
      for (const secret of Object.values(secrets))
        assert(!response.text.includes(secret));
      assert(!response.text.includes("ciphertext"));
    }
    await f.request("/api/connection/test", { method: "POST", value: {} });
    await f.request("/api/settings/provider/test-connection", {
      method: "POST",
      value: {},
    });
    await f.request("/api/settings/assistant/test-connection", {
      method: "POST",
      value: {},
    });
    assert.deepEqual(
      f.outbound.map((c) => c.headers.Authorization),
      [
        `Bearer ${secrets.redbark}`,
        `Bearer ${secrets.provider}`,
        `Bearer ${secrets.assistant}`,
      ],
    );
    assert(
      f.outbound.every(
        (c) =>
          /^https:\/\/api\.(redbark|openai)\.com\//.test(c.url) &&
          c.redirect === "error",
      ),
    );
    f.setHook(async () => {
      throw Error(
        `${secrets.provider} ${secrets.assistant} ${secrets.redbark}`,
      );
    });
    for (const path of [
      "/api/connection/test",
      "/api/settings/provider/test-connection",
      "/api/settings/assistant/test-connection",
    ])
      assert.equal(
        (await f.request(path, { method: "POST", value: {} })).status,
        502,
      );
    const rows = (await f.pool.query("SELECT * FROM encrypted_credentials"))
      .rows;
    for (const secret of Object.values(secrets)) {
      assert(!JSON.stringify(rows).includes(secret));
      assert(!JSON.stringify(f.transcript).includes(secret));
    }
    t.diagnostic(
      `${f.transcript.length} HTTP requests; ${f.outbound.length} mocked outbound calls; all destinations fixed and error/readback secret-free`,
    );
  },
);

dbTest(
  "adversarial live HTTP: sensitive settings and connection tests are bounded to five requests",
  async (t) => {
    const f = await fixture(t);
    await f.redbark.save({ apiKey: secrets.redbark });
    await f.settings.saveProvider({
      ...baseProvider,
      apiKey: secrets.provider,
    });
    await f.assistantSettings.save({
      provider: "openai",
      model: "synthetic-model",
      apiKey: secrets.assistant,
    });
    const endpoints = [
      ["/api/settings/provider/test-connection", "POST", {}, 200],
      ["/api/settings/assistant/test-connection", "POST", {}, 200],
      ["/api/connection/test", "POST", {}, 200],
      ["/api/settings/provider", "PUT", { ...baseProvider }, 200],
      [
        "/api/settings/assistant",
        "PUT",
        { provider: "openai", model: "synthetic-model" },
        200,
      ],
      ["/api/settings/redbark", "PUT", { apiKey: secrets.redbark }, 200],
      ["/api/settings/provider/test-model", "POST", {}, 400],
      ["/api/settings/assistant/test-model", "POST", {}, 400],
      [
        "/api/settings/webhook/register",
        "POST",
        { publicBaseUrl: "http://127.0.0.1" },
        400,
      ],
      ["/api/settings/webhook/test", "POST", {}, 409],
    ];
    for (const [path, method, value, expected] of endpoints) {
      const statuses = [];
      for (let i = 0; i < 7; i++)
        statuses.push((await f.request(path, { method, value })).status);
      t.diagnostic(`${method} ${path}: ${statuses.join(",")}`);
      assert.deepEqual(
        statuses,
        [expected, expected, expected, expected, expected, 429, 429],
        path,
      );
    }
  },
);

dbTest(
  "adversarial live HTTP: wrong key, tampering and cross-slot ciphertext fail closed",
  async (t) => {
    const f = await fixture(t);
    await f.redbark.save({
      apiKey: secrets.redbark,
      signingSecret: secrets.signing,
    });
    await f.settings.saveProvider({
      ...baseProvider,
      apiKey: secrets.provider,
    });
    await f.assistantSettings.save({
      provider: "openai",
      model: "synthetic-model",
      enabled: true,
      dataSharingAcknowledged: true,
      apiKey: secrets.assistant,
    });
    const wrongSecret = randomBytes(32).toString("base64"),
      wrongSettings = createSettingsStore({
        pool: f.pool,
        appSecret: wrongSecret,
      });
    const wrongRedbark = createRedbarkSettings({
      pool: f.pool,
      settings: wrongSettings,
      appSecret: wrongSecret,
    });
    const wrongIntegration = createRedbarkIntegration({
      pool: f.pool,
      store: f.store,
      config: f.config,
      getRedbarkConfig: wrongRedbark.getRuntimeConfig,
      fetchImpl: () => {
        throw Error("MUST NOT FETCH");
      },
    });
    const wrong = await f.serve({
      settings: wrongSettings,
      redbarkSettings: wrongRedbark,
      integration: wrongIntegration,
      assistantSettings: createAssistantSettings({
        pool: f.pool,
        appSecret: wrongSecret,
      }),
    });
    for (const kind of ["redbark", "provider", "assistant"])
      assert.equal(
        (await wrong(`/api/settings/${kind}`)).json.credentialsAvailable,
        false,
      );
    for (const path of [
      "/api/connection/test",
      "/api/settings/provider/test-connection",
      "/api/settings/assistant/test-connection",
    ])
      assert.equal(
        (await wrong(path, { method: "POST", value: {} })).status,
        409,
      );
    const rows = (await f.pool.query("SELECT * FROM encrypted_credentials"))
      .rows;
    await f.pool.query(
      "UPDATE encrypted_credentials SET ciphertext=$1 WHERE setting='llm.apiKey'",
      [rows.find((r) => r.setting === "assistant.llm.apiKey").ciphertext],
    );
    await f.pool.query(
      "UPDATE encrypted_credentials SET ciphertext=$1 WHERE setting='redbark.apiKey'",
      [
        rows.find((r) => r.setting === "redbark.webhook.signingSecret")
          .ciphertext,
      ],
    );
    const tampered = {
      ...rows.find((r) => r.setting === "assistant.llm.apiKey").ciphertext,
      tag: randomBytes(16).toString("base64"),
    };
    await f.pool.query(
      "UPDATE encrypted_credentials SET ciphertext=$1 WHERE setting='assistant.llm.apiKey'",
      [tampered],
    );
    for (const kind of ["redbark", "provider", "assistant"])
      assert.equal(
        (await f.request(`/api/settings/${kind}`)).json.credentialsAvailable,
        false,
      );
    for (const path of [
      "/api/connection/test",
      "/api/settings/provider/test-connection",
      "/api/settings/assistant/test-connection",
    ])
      assert.equal(
        (await f.request(path, { method: "POST", value: {} })).status,
        409,
      );
    assert.equal(f.outbound.length, 0);
    for (const secret of Object.values(secrets))
      assert(!JSON.stringify(f.transcript).includes(secret));
  },
);

dbTest(
  "adversarial live HTTP: account replacement revokes old signatures, destinations, queued jobs and stale verification",
  async (t) => {
    const f = await fixture(t);
    await f.redbark.save({
      apiKey: secrets.redbark,
      signingSecret: secrets.signing,
    });
    assert.equal(
      (await f.request("/api/connection/test", { method: "POST", value: {} }))
        .status,
      200,
    );
    const raw = JSON.stringify({
      id: "evt_OriginalAccount",
      object: "event",
      type: "sync_run.succeeded",
      created: new Date().toISOString(),
      livemode: true,
    });
    assert.equal(
      (
        await f.request("/api/webhooks/redbark", {
          method: "POST",
          who: "anonymous",
          origin: null,
          value: raw,
          headers: { "redbark-signature": signature(raw, secrets.signing) },
        })
      ).status,
      200,
    );
    await f.registration.register({
      publicBaseUrl: "https://finance.dolphino.app",
      recoverSigningSecret: true,
    });
    let release, started;
    const pending = new Promise((r) => {
      started = r;
    });
    let held = false;
    f.setHook(async (url) => {
      if (!held && url.includes("redbark")) {
        held = true;
        started();
        await new Promise((r) => {
          release = r;
        });
      }
    });
    const stale = f.request("/api/connection/test", {
      method: "POST",
      value: {},
    });
    await pending;
    assert.equal(
      (
        await f.request("/api/settings/redbark", {
          method: "PUT",
          value: { apiKey: "synthetic-redbark-api-B" },
        })
      ).status,
      200,
    );
    assert.equal(
      (await f.request("/api/connection/test", { method: "POST", value: {} }))
        .status,
      200,
    );
    release();
    assert.equal((await stale).status, 409);
    assert.equal((await f.integration.status()).verified, true);
    assert.equal(
      (
        await f.request("/api/webhooks/redbark", {
          method: "POST",
          who: "anonymous",
          origin: null,
          value: raw,
          headers: { "redbark-signature": signature(raw, secrets.signing) },
        })
      ).status,
      503,
    );
    const remoteBefore = f.remote.length;
    assert.equal(
      (
        await f.request("/api/settings/webhook/test", {
          method: "POST",
          value: {},
        })
      ).status,
      409,
    );
    assert.equal(f.remote.length, remoteBefore);
    assert.equal(
      (await f.request("/api/settings/webhook")).json.destinationId,
      null,
    );
    await f.integration.tick();
    assert.equal(
      (
        await f.pool.query(
          "SELECT status FROM redbark_jobs WHERE dedupe_key='event:evt_OriginalAccount'",
        )
      ).rows[0].status,
      "queued",
    );
    assert(f.outbound.slice(-1)[0].headers.Authorization.endsWith("api-B"));
  },
);

dbTest(
  "adversarial live HTTP: manual classification works with automation off, settings remain isolated from financial grants",
  async (t) => {
    const f = await fixture(t);
    const tx = await f.store.ingest({
      sourceId: "synthetic-classification",
      accountId: "acct_A",
      currency: "AUD",
      amountMinor: "-100",
      status: "posted",
      date: "2026-09-01",
      category: "Groceries",
      kind: "expense",
      description: "Synthetic shop",
    });
    const other = await f.store.ingest({
      sourceId: "synthetic-hidden",
      accountId: "acct_B",
      currency: "AUD",
      amountMinor: "-200",
      status: "posted",
      date: "2026-09-01",
      category: "Groceries",
      kind: "expense",
      description: "Hidden merchant",
    });
    await f.settings.saveProvider({
      ...baseProvider,
      apiKey: secrets.provider,
    });
    await f.classification.tick();
    assert.equal(f.outbound.length, 0);
    assert.equal(
      (
        await f.request(`/api/transactions/${tx.id}/suggest`, {
          method: "POST",
          value: {},
        })
      ).status,
      200,
    );
    assert.equal(f.outbound.length, 1);
    await f.store.atomic(
      (c) =>
        validateAndSetGrants(
          c,
          f.users.member,
          { accounts: [{ accountId: "acct_A", access: "view" }] },
          { mode: "live" },
        ),
      { refresh: false },
    );
    assert.equal(
      (await f.request(`/api/transactions/${other.id}`, { who: "member" }))
        .status,
      404,
    );
    const accounts = await f.request("/api/assistant/tools/finance_accounts", {
      who: "member",
      method: "POST",
      value: { currency: "AUD" },
    });
    assert.equal(accounts.status, 200);
    assert(!accounts.text.includes("acct_B"));
    assert.equal(
      (
        await f.request("/api/assistant/tools/finance_transaction", {
          who: "member",
          method: "POST",
          value: { currency: "AUD", transactionId: other.id },
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await f.request(`/api/transactions/${tx.id}/suggest`, {
          who: "member",
          method: "POST",
          value: {},
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await f.request("/api/settings/provider", {
          who: "member",
          method: "PUT",
          value: { ...baseProvider, enabled: false },
        })
      ).status,
      403,
    );
    await f.settings.saveProvider({ ...baseProvider, enabled: false });
    assert.equal(
      (
        await f.request(`/api/transactions/${tx.id}/suggest`, {
          method: "POST",
          value: {},
        })
      ).status,
      409,
    );
    assert.equal(f.outbound.length, 1);
  },
);

dbTest(
  "adversarial live HTTP: in-flight provider tests keep coherent key/model revisions during a hot save",
  async (t) => {
    const f = await fixture(t);
    await f.settings.saveProvider({
      ...baseProvider,
      model: "model-A",
      apiKey: "synthetic-key-A",
    });
    await f.assistantSettings.save({
      provider: "openai",
      model: "assistant-A",
      apiKey: "synthetic-assistant-A",
    });
    let release, started;
    const ready = new Promise((resolve) => {
      started = resolve;
    });
    let held = false;
    f.setHook(async (url) => {
      if (!held && url.includes("/models/model-A")) {
        held = true;
        started();
        await new Promise((resolve) => {
          release = resolve;
        });
      }
    });
    const pending = f.request("/api/settings/provider/test-connection", {
      method: "POST",
      value: {},
    });
    await ready;
    assert.equal(
      (
        await f.request("/api/settings/provider", {
          method: "PUT",
          value: {
            ...baseProvider,
            model: "model-B",
            apiKey: "synthetic-key-B",
          },
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await f.request("/api/settings/provider/test-connection", {
          method: "POST",
          value: {},
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await f.request("/api/settings/assistant/test-connection", {
          method: "POST",
          value: {},
        })
      ).status,
      200,
    );
    release();
    assert.equal((await pending).status, 200);
    assert.deepEqual(
      f.outbound.map((c) => [new URL(c.url).pathname, c.headers.Authorization]),
      [
        ["/v1/models/model-A", "Bearer synthetic-key-A"],
        ["/v1/models/model-B", "Bearer synthetic-key-B"],
        ["/v1/models/assistant-A", "Bearer synthetic-assistant-A"],
      ],
    );
    assert.equal(
      (await f.request("/api/settings/provider")).json.model,
      "model-B",
    );
  },
);

dbTest(
  "adversarial live HTTP: Bedrock SDK ignores environment endpoints and uses separate explicit database credentials",
  async (t) => {
    const f = await fixture(t),
      sdkCalls = [];
    const names = [
      "AWS_ENDPOINT_URL",
      "AWS_ENDPOINT_URL_STS",
      "AWS_ENDPOINT_URL_BEDROCK",
      "AWS_ENDPOINT_URL_BEDROCK_RUNTIME",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
    ];
    const before = Object.fromEntries(
      names.map((name) => [name, process.env[name]]),
    );
    for (const name of names)
      process.env[name] = name.includes("ENDPOINT")
        ? "http://127.0.0.1:1/credential-theft"
        : "synthetic-env-never-use";
    const originals = [STSClient, BedrockClient, BedrockRuntimeClient].map(
      (Client) => [Client, Client.prototype.send],
    );
    for (const [Client] of originals)
      Client.prototype.send = async function (command) {
        const ignored =
          typeof this.config.ignoreConfiguredEndpointUrls === "function"
            ? await this.config.ignoreConfiguredEndpointUrls()
            : this.config.ignoreConfiguredEndpointUrls;
        const credentials = await this.config.credentials();
        sdkCalls.push({
          client: Client.name,
          command: command.constructor.name,
          ignored,
          credentials,
          region: await this.config.region(),
        });
        if (command.constructor.name === "GetInferenceProfileCommand")
          throw Object.assign(Error("Synthetic foundation model"), {
            name: "ValidationException",
          });
        if (
          command.constructor.name === "GetFoundationModelAvailabilityCommand"
        )
          return {
            authorizationStatus: "AUTHORIZED",
            entitlementAvailability: "AVAILABLE",
            regionAvailability: "AVAILABLE",
            agreementAvailability: { status: "AVAILABLE" },
          };
        if (command.constructor.name === "ConverseCommand")
          return {
            output: {
              message: {
                content: [
                  {
                    text: JSON.stringify({
                      category: "Groceries",
                      reason: "Synthetic",
                    }),
                  },
                ],
              },
            },
          };
        return {
          Account: "000000000000",
          Arn: "arn:aws:iam::000000000000:user/synthetic",
        };
      };
    try {
      const provider = {
        ...baseProvider,
        provider: "bedrock",
        model: "synthetic-model",
        region: "us-east-1",
        accessKeyId: "AKIASYNTHETICCLASSIFY",
        secretAccessKey: "synthetic-classifier-secret",
      };
      assert.equal(
        (
          await f.request("/api/settings/provider", {
            method: "PUT",
            value: provider,
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await f.request("/api/settings/assistant", {
            method: "PUT",
            value: {
              provider: "bedrock",
              model: "synthetic-model",
              region: "us-east-1",
              accessKeyId: "AKIASYNTHETICASSISTANT",
              secretAccessKey: "synthetic-assistant-secret",
            },
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await f.request("/api/settings/provider/test-connection", {
            method: "POST",
            value: {},
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await f.request("/api/settings/assistant/test-connection", {
            method: "POST",
            value: {},
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await f.request("/api/settings/provider/test-model", {
            method: "POST",
            value: { acknowledgeCost: true },
          })
        ).status,
        200,
      );
      assert(sdkCalls.length >= 5);
      assert(
        sdkCalls.every((c) => c.ignored === true && c.region === "us-east-1"),
      );
      assert.equal(
        sdkCalls[0].credentials.accessKeyId,
        "AKIASYNTHETICCLASSIFY",
      );
      assert.equal(
        sdkCalls[1].credentials.accessKeyId,
        "AKIASYNTHETICASSISTANT",
      );
      assert(
        sdkCalls
          .slice(2)
          .every((c) => c.credentials.accessKeyId === "AKIASYNTHETICCLASSIFY"),
      );
      assert.equal(f.outbound.length, 0);
      assert.equal(
        (
          await f.request("/api/settings/provider", {
            method: "PUT",
            value: { ...provider, accessKeyId: "ASIASYNTHETICTEMPORARY" },
          })
        ).status,
        400,
      );
      t.diagnostic(
        `${sdkCalls.length} SDK boundary calls: explicit database keys, ignoreConfiguredEndpointUrls=true`,
      );
    } finally {
      for (const [Client, send] of originals) Client.prototype.send = send;
      for (const name of names)
        if (before[name] === undefined) delete process.env[name];
        else process.env[name] = before[name];
    }
  },
);

test(
  "adversarial live HTTP: PostgreSQL shutdown is fail-closed, retry resumes only after database recovery",
  {
    skip: !connectionString || !process.env.DOLPHINO_DB_SHUTDOWN_TEST,
    timeout: 30000,
  },
  async (t) => {
    assert.equal(
      process.env.DOLPHINO_TEST_PG_ISOLATED,
      "1",
      "Shutdown testing requires an explicitly isolated test-owned PostgreSQL fixture",
    );
    assert(
      process.env.DOLPHINO_TEST_PG_CTL &&
        process.env.DOLPHINO_TEST_PG_DATA_DIR &&
        process.env.PGPORT,
      "Provide PG_CTL, DATA_DIR and PGPORT for the isolated fixture",
    );
    const f = await fixture(t);
    await f.redbark.save({ apiKey: secrets.redbark });
    await f.settings.saveProvider({
      ...baseProvider,
      apiKey: secrets.provider,
    });
    const pgctl = process.env.DOLPHINO_TEST_PG_CTL;
    const data = process.env.DOLPHINO_TEST_PG_DATA_DIR;
    try {
      execFileSync(pgctl, ["-D", data, "-m", "fast", "-w", "stop"], {
        stdio: "pipe",
      });
      for (const path of [
        "/api/settings/provider",
        "/api/settings/redbark",
        "/api/settings/assistant",
      ])
        assert.equal((await f.request(path)).status, 500);
      for (const path of [
        "/api/connection/test",
        "/api/settings/provider/test-connection",
      ])
        assert.equal(
          (await f.request(path, { method: "POST", value: {} })).status,
          500,
        );
      await f.classification.tick();
      await assert.rejects(f.integration.tick());
      assert.equal(f.outbound.length, 0);
    } finally {
      execFileSync(
        pgctl,
        [
          "-D",
          data,
          "-l",
          `${data}/adversarial-restart.log`,
          "-o",
          `-h 127.0.0.1 -p ${process.env.PGPORT} -c unix_socket_directories=''`,
          "-w",
          "start",
        ],
        { stdio: "pipe" },
      );
    }
    assert.equal((await f.request("/api/settings/provider")).status, 200);
    assert.equal(
      (
        await f.request("/api/settings/provider/test-connection", {
          method: "POST",
          value: {},
        })
      ).status,
      200,
    );
    assert.equal(f.outbound.length, 1);
  },
);

dbTest(
  "adversarial live HTTP: webhook registration rejects transition and documentation DNS addresses",
  async (t) => {
    const f = await fixture(t);
    await f.redbark.save({ apiKey: secrets.redbark });
    await f.integration.testConnection();
    for (const address of [
      "2002:7f00:1::1",
      "192.0.2.15",
      "2001:db8::1",
      "127.0.0.1",
    ]) {
      let calls = 0;
      const registration = createRegistration({
        pool: f.pool,
        settings: f.settings,
        config: f.config,
        getRedbarkConfig: f.redbark.getRuntimeConfig,
        lookupImpl: async () => [{ address }],
        client: {
          list: async () => {
            calls++;
            return [];
          },
          request: async () => {
            calls++;
            return {
              body: {
                id: "ed_Synthetic",
                webhook_endpoint: {
                  signing_secret: "synthetic-remote-signing-secret",
                },
              },
            };
          },
        },
      });
      const request = await f.serve({ registration });
      const result = await request("/api/settings/webhook/register", {
        method: "POST",
        value: { publicBaseUrl: "https://finance.dolphino.app" },
      });
      t.diagnostic(
        `Webhook callback mocked DNS ${address}: HTTP ${result.status}, remote calls ${calls}`,
      );
      assert.equal(
        result.status,
        409,
        `${address} must not become a provider callback`,
      );
      assert.equal(calls, 0);
    }
  },
);
