import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { randomBytes, randomUUID, createHmac } from "node:crypto";
import { createSettingsStore } from "../src/settings.js";
import {
  createRedbarkSettings,
  redbarkSettingsSchema,
  redbarkAccountFingerprint,
} from "../src/redbark-settings.js";
import { createRedbarkIntegration } from "../src/worker.js";
import { createRegistration } from "../src/registration.js";
const connectionString =
  process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
async function fixture(t) {
  const admin = new pg.Pool({ connectionString });
  const schema = `redbark_settings_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({
    connectionString,
    options: `-c search_path=${schema}`,
  });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });
  const appSecret = randomBytes(32).toString("base64");
  const settings = createSettingsStore({ pool, appSecret });
  await settings.init();
  const redbark = createRedbarkSettings({ pool, settings, appSecret });
  return { pool, appSecret, settings, redbark };
}
function signature(body, secret) {
  const timestamp = Math.floor(Date.now() / 1000);
  return {
    "redbark-signature": `t=${timestamp},v1=${createHmac("sha256", secret).update(`${timestamp}.`).update(body).digest("hex")}`,
  };
}
const event = (id) =>
  Buffer.from(
    JSON.stringify({
      id,
      object: "event",
      type: "sync_run.succeeded",
      livemode: true,
      created: new Date().toISOString(),
    }),
  );

test("Redbark schema rejects unexpected endpoints and bounds, empty input preserves secrets", () => {
  for (const value of [
    { baseUrl: "http://127.0.0.1" },
    { version: "x\r\nAuthorization: bad" },
    { backfillDays: 0 },
    { backfillDays: 2556 },
    { backfillDays: 1.5 },
    { apiKey: "has spaces" },
    { signingSecret: "short" },
  ])
    assert.equal(redbarkSettingsSchema.safeParse(value).success, false);
  assert.equal(redbarkSettingsSchema.parse({ apiKey: "" }).apiKey, undefined);
  assert.equal(redbarkSettingsSchema.parse({ apiKey: null }).apiKey, null);
});

test(
  "Redbark PostgreSQL encrypted write-only settings, hot reload and binding survive restart",
  { skip: !connectionString },
  async (t) => {
    const { pool, appSecret, settings, redbark } = await fixture(t);
    assert.equal((await redbark.getPublic()).configured, false);
    const key = "fictional-api-key-unique-A",
      secret = "fictional-webhook-signing-secret-A";
    const saved = await redbark.save({
      apiKey: key,
      signingSecret: secret,
      backfillDays: 37,
    });
    assert.equal(saved.signingSecretAssociated, true);
    assert(!JSON.stringify(saved).includes(key));
    assert(!JSON.stringify(saved).includes(secret));
    assert.equal((await redbark.getRuntimeConfig()).redbarkBackfillDays, 37);
    const rows = (await pool.query("SELECT * FROM encrypted_credentials")).rows;
    assert.equal(rows.length, 2);
    assert(!JSON.stringify(rows).includes(key));
    assert(!JSON.stringify(rows).includes(secret));
    const before = (await redbark.getRuntimeConfig()).redbarkFingerprint;
    await redbark.save({ apiKey: "", signingSecret: "", backfillDays: 37 });
    assert.equal((await redbark.getRuntimeConfig()).redbarkFingerprint, before);
    const restarted = createRedbarkSettings({ pool, settings, appSecret });
    assert.equal(
      (await restarted.getRuntimeConfig()).redbarkWebhookSecret,
      secret,
    );
    await redbark.save({ apiKey: "fictional-api-key-B" });
    assert.equal(
      (await restarted.getRuntimeConfig()).redbarkWebhookSecret,
      "",
      "old signing key cannot authenticate new account",
    );
    assert.equal(
      (await redbark.getPublic()).credentials.signingSecret.configured,
      true,
      "legacy ciphertext preserved in existing slot, but unbound",
    );
    await redbark.save({ signingSecret: "fictional-webhook-signing-secret-B" });
    assert.equal(
      (await restarted.getRuntimeConfig()).redbarkWebhookSecret,
      "fictional-webhook-signing-secret-B",
    );
    await redbark.save({ apiKey: null, signingSecret: null });
    assert.equal((await restarted.getPublic()).configured, false);
    assert.equal(
      (await pool.query("SELECT * FROM encrypted_credentials")).rowCount,
      0,
    );
  },
);

test(
  "wrong APP_SECRET, ciphertext tampering and slot swapping fail closed without fallback",
  { skip: !connectionString },
  async (t) => {
    const { pool, settings, appSecret, redbark } = await fixture(t);
    await redbark.save({
      apiKey: "fictional-api-key",
      signingSecret: "fictional-signing-secret",
    });
    const wrong = createRedbarkSettings({
      pool,
      settings,
      appSecret: randomBytes(32).toString("base64"),
    });
    const wrongState = await wrong.getRuntimeConfig();
    assert.equal(wrongState.redbarkApiKey, "");
    assert.equal(wrongState.redbarkWebhookSecret, "");
    assert.equal((await wrong.getPublic()).credentialsAvailable, false);
    const rows = (
      await pool.query("SELECT * FROM encrypted_credentials ORDER BY setting")
    ).rows;
    await pool.query(
      "UPDATE encrypted_credentials SET ciphertext=$1 WHERE setting='redbark.apiKey'",
      [rows.find((r) => r.setting.includes("signingSecret")).ciphertext],
    );
    assert.equal(
      (await redbark.getRuntimeConfig()).redbarkCredentialsUnavailable,
      true,
    );
    await redbark.save({ apiKey: "fictional-replacement-key" });
    const replacement = (
      await pool.query(
        "SELECT ciphertext FROM encrypted_credentials WHERE setting='redbark.apiKey'",
      )
    ).rows[0].ciphertext;
    replacement.tag = randomBytes(16).toString("base64");
    await pool.query(
      "UPDATE encrypted_credentials SET ciphertext=$1 WHERE setting='redbark.apiKey'",
      [replacement],
    );
    assert.equal((await redbark.getRuntimeConfig()).redbarkApiKey, "");
    assert.equal(
      (await createRedbarkSettings({ pool, settings, appSecret }).getPublic())
        .credentialsAvailable,
      false,
    );
  },
);

test(
  "runtime uses exact tested snapshot, rejects stale test and never runs old-account jobs",
  { skip: !connectionString },
  async (t) => {
    const { pool, redbark } = await fixture(t);
    let started,
      release,
      deferred = false;
    const calls = [];
    const integration = createRedbarkIntegration({
      pool,
      config: { mode: "live", redbarkApiKey: "ignored-env" },
      store: { ingestBatch: async () => {} },
      getRedbarkConfig: redbark.getRuntimeConfig,
      fetchImpl: async (url, options) => {
        calls.push({ url: String(url), headers: options.headers });
        if (deferred) {
          deferred = false;
          started();
          await new Promise((resolve) => {
            release = resolve;
          });
        }
        return Response.json({ data: [], next_page_url: null });
      },
    });
    await integration.init();
    await assert.rejects(integration.testConnection(), /not_configured/);
    await redbark.save({
      apiKey: "fictional-key-A",
      signingSecret: "fictional-signing-key-A",
    });
    await integration.testConnection();
    assert.equal((await integration.status()).verified, true);
    const body = event("evt_oldaccount");
    await integration.receiveWebhook(
      body,
      signature(body, "fictional-signing-key-A"),
    );
    await pool.query(
      "INSERT INTO redbark_jobs(dedupe_key) VALUES('legacy:unbound')",
    );
    let startResolve;
    const start = new Promise((resolve) => {
      startResolve = resolve;
    });
    started = startResolve;
    deferred = true;
    const stale = integration.testConnection();
    await start;
    await redbark.save({ apiKey: "fictional-key-B" });
    await integration.testConnection();
    assert.equal((await integration.status()).verified, true);
    release();
    await assert.rejects(stale, /configuration_changed_retest_required/);
    assert.equal(
      (await integration.status()).verified,
      true,
      "stale test cannot replace newer verification",
    );
    await assert.rejects(
      integration.receiveWebhook(
        body,
        signature(body, "fictional-signing-key-A"),
      ),
      /not_configured/,
    );
    await integration.tick();
    assert.equal(
      (
        await pool.query(
          "SELECT status FROM redbark_jobs WHERE dedupe_key='event:evt_oldaccount'",
        )
      ).rows[0].status,
      "queued",
    );
    assert.equal(
      (
        await pool.query(
          "SELECT status FROM redbark_jobs WHERE dedupe_key='legacy:unbound'",
        )
      ).rows[0].status,
      "queued",
    );
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM redbark_jobs WHERE status='completed' AND account_fingerprint=$1",
          [redbarkAccountFingerprint("fictional-key-B")],
        )
      ).rows[0].n,
      1,
    );
    await redbark.save({ version: "2026-10-02.wattle" });
    assert.equal((await integration.status()).verified, false);
    const before = calls.length;
    await integration.tick();
    assert.equal(calls.length, before);
    await redbark.save({ apiKey: null });
    await integration.tick();
    assert.equal(calls.length, before);
    assert(calls.every((c) => c.url.startsWith("https://api.redbark.com/v2/")));
  },
);

test(
  "registration account changes cannot reuse destination/signing-secret association",
  { skip: !connectionString },
  async (t) => {
    const { pool, settings, redbark } = await fixture(t);
    const integration = createRedbarkIntegration({
      pool,
      store: {},
      config: { mode: "live" },
      getRedbarkConfig: redbark.getRuntimeConfig,
      fetchImpl: async () => Response.json({ data: [] }),
    });
    await integration.init();
    const remoteSecret = "fictional-remote-signing-secret";
    let rotations = 0,
      pings = 0;
    const destination = {
      id: "ed_shared",
      status: "enabled",
      webhook_endpoint: {
        url: "https://finance.stefan.com/api/webhooks/redbark",
      },
    };
    const registration = createRegistration({
      pool,
      settings,
      config: { mode: "live" },
      getRedbarkConfig: redbark.getRuntimeConfig,
      lookupImpl: async () => [{ address: "93.184.216.34" }],
      client: {
        list: async () => [destination],
        request: async (path) => {
          if (path.endsWith("/rotate_secret")) rotations++;
          if (path.endsWith("/ping")) {
            pings++;
            return { body: { id: "evt_ping" } };
          }
          return {
            body: {
              ...destination,
              webhook_endpoint: {
                ...destination.webhook_endpoint,
                signing_secret: remoteSecret,
              },
            },
          };
        },
      },
    });
    await registration.init();
    await redbark.save({ apiKey: "fictional-A" });
    await integration.testConnection();
    await registration.register({
      publicBaseUrl: "https://finance.stefan.com",
      recoverSigningSecret: true,
    });
    await registration.test();
    assert.equal(pings, 1);
    await redbark.save({ apiKey: "fictional-B" });
    await integration.testConnection();
    await assert.rejects(registration.test(), /registration_required/);
    assert.equal(pings, 1);
    await assert.rejects(
      registration.register({ publicBaseUrl: "https://finance.stefan.com" }),
      /signing_secret_recovery_required/,
    );
    await registration.register({
      publicBaseUrl: "https://finance.stefan.com",
      recoverSigningSecret: true,
    });
    assert.equal(rotations, 2);
    assert.equal(await registration.runtimeSigningSecret(), remoteSecret);
  },
);
