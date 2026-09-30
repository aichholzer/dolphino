import { createHash } from "node:crypto";
import {
  RedbarkClient,
  RedbarkError,
  REDBARK_VERSION,
  configurationFingerprint,
  verifyRedbarkSignature,
  parseThinEvent,
  normalizeTransaction,
} from "./redbark.js";

export async function ensureRedbarkSchema(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS redbark_state (id integer PRIMARY KEY CHECK(id=1), fingerprint text, tested_at timestamptz, last_success timestamptz, last_error text, next_attempt timestamptz);
    ALTER TABLE redbark_state ADD COLUMN IF NOT EXISTS next_attempt timestamptz;
    INSERT INTO redbark_state(id) VALUES(1) ON CONFLICT DO NOTHING;
    CREATE TABLE IF NOT EXISTS redbark_receipts (event_id text PRIMARY KEY, body bytea NOT NULL, body_hash text NOT NULL, received_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS redbark_jobs (id bigserial PRIMARY KEY, dedupe_key text UNIQUE NOT NULL, status text NOT NULL DEFAULT 'queued', attempts integer NOT NULL DEFAULT 0, available_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz, last_error text);
    ALTER TABLE redbark_jobs ADD COLUMN IF NOT EXISTS params jsonb NOT NULL DEFAULT '{}';
    CREATE TABLE IF NOT EXISTS redbark_fetches (id bigserial PRIMARY KEY, account_id text NOT NULL, fetched_at timestamptz NOT NULL, raw jsonb NOT NULL);
    CREATE OR REPLACE FUNCTION reject_redbark_evidence_changes() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Redbark evidence is immutable'; END; $$;
    DROP TRIGGER IF EXISTS immutable_redbark_fetches ON redbark_fetches;
    CREATE TRIGGER immutable_redbark_fetches BEFORE UPDATE OR DELETE ON redbark_fetches FOR EACH ROW EXECUTE FUNCTION reject_redbark_evidence_changes();
    DROP TRIGGER IF EXISTS immutable_redbark_receipts ON redbark_receipts;
    CREATE TRIGGER immutable_redbark_receipts BEFORE UPDATE OR DELETE ON redbark_receipts FOR EACH ROW EXECUTE FUNCTION reject_redbark_evidence_changes();
  `);
}
export function createRedbarkIntegration({
  pool,
  store,
  config,
  fetchImpl,
  getWebhookSecret = async () => config.redbarkWebhookSecret,
  now = Date.now,
  timerIntervalMs = 15000,
}) {
  const client = new RedbarkClient({
    apiKey: config.redbarkApiKey,
    version: config.redbarkVersion || REDBARK_VERSION,
    fetchImpl,
  });
  const fingerprint = configurationFingerprint(config);
  let timer;
  let busy = false;
  const idleWaiters = [];
  const configured = () =>
    config.mode === "live" && Boolean(config.redbarkApiKey);
  async function status() {
    const {
      rows: [state],
    } = await pool.query("SELECT * FROM redbark_state WHERE id=1");
    const {
      rows: [counts],
    } = await pool.query(
      "SELECT count(*)::integer AS pending FROM redbark_jobs WHERE status='queued'",
    );
    let webhookConfigured = false;
    try {
      webhookConfigured = Boolean(await getWebhookSecret());
    } catch {
      /* Credential failure must not block stored-data/status access. */
    }
    return {
      configured: configured(),
      verified: configured() && state?.fingerprint === fingerprint,
      version: config.redbarkVersion || REDBARK_VERSION,
      webhookConfigured,
      testedAt: state?.tested_at,
      lastSuccess: state?.last_success,
      lastPollAt: state?.last_success,
      lastError: state?.last_error,
      queuedJobs: counts.pending,
      pollHours: 4,
    };
  }
  async function testConnection() {
    if (!configured())
      throw new RedbarkError("live_redbark_not_configured", 409);
    try {
      const response = await client.request("accounts?limit=1");
      if (!Array.isArray(response.body?.data))
        throw new RedbarkError("invalid_provider_list");
      await pool.query(
        "UPDATE redbark_state SET fingerprint=$1,tested_at=now(),last_error=NULL WHERE id=1",
        [fingerprint],
      );
      return { ok: true, version: client.version };
    } catch (error) {
      await pool.query(
        "UPDATE redbark_state SET fingerprint=NULL,tested_at=now(),last_error=$1 WHERE id=1",
        [error instanceof RedbarkError ? error.code : "connection_test_failed"],
      );
      throw error;
    }
  }
  async function receiveWebhook(rawBody, headers) {
    let webhookSecret;
    try {
      webhookSecret = await getWebhookSecret();
    } catch {
      throw new RedbarkError("webhook_credentials_unavailable", 503);
    }
    if (!configured() || !webhookSecret)
      throw new RedbarkError("webhook_not_configured", 503);
    if (
      !verifyRedbarkSignature(
        headers["redbark-signature"],
        rawBody,
        webhookSecret,
      )
    )
      throw new RedbarkError("invalid_signature", 401);
    const event = parseThinEvent(rawBody);
    const hash = createHash("sha256").update(rawBody).digest("hex");
    const db = await pool.connect();
    try {
      await db.query("BEGIN");
      const inserted = await db.query(
        "INSERT INTO redbark_receipts(event_id,body,body_hash) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING event_id",
        [event.id, Buffer.from(rawBody), hash],
      );
      if (!inserted.rowCount) {
        const {
          rows: [prior],
        } = await db.query(
          "SELECT body_hash FROM redbark_receipts WHERE event_id=$1",
          [event.id],
        );
        if (prior.body_hash !== hash)
          throw new RedbarkError("event_id_conflict", 409);
      }
      if (event.type !== "event_destination.ping")
        await db.query(
          "INSERT INTO redbark_jobs(dedupe_key) VALUES($1) ON CONFLICT DO NOTHING",
          [`event:${event.id}`],
        );
      await db.query("COMMIT");
      return { accepted: true, duplicate: !inserted.rowCount };
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    } finally {
      db.release();
    }
  }
  async function sync(params = {}) {
    const accounts = await client.accounts();
    const timezone = config.timezone || "Australia/Brisbane";
    const to =
      params.to ||
      new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date());
    const days = Number(config.redbarkBackfillDays || 90);
    if (!Number.isInteger(days) || days < 1 || days > 2555)
      throw new RedbarkError("invalid_backfill_days");
    const from =
      params.from ||
      new Date(Date.parse(to) - days * 86400000).toISOString().slice(0, 10);
    if (
      params.accountId &&
      !accounts.some(
        (a) =>
          a.id === params.accountId &&
          (a.category === "banking" || a.provider === "documents"),
      )
    )
      throw new RedbarkError("backfill_account_unavailable", 409);
    for (const rawAccount of accounts) {
      if (params.accountId && rawAccount.id !== params.accountId) continue;
      if (
        rawAccount.category !== "banking" &&
        rawAccount.provider !== "documents"
      )
        continue;
      if (
        !/^acct_[a-zA-Z0-9]+$/.test(rawAccount.id) ||
        !/^[a-zA-Z]{3}$/.test(rawAccount.currency)
      )
        throw new RedbarkError("invalid_provider_account");
      const fetchedAt = new Date().toISOString();
      const rawBalance =
        rawAccount.category === "banking"
          ? await client.balance(rawAccount.id)
          : null;
      const rawTransactions = await client.transactions(
        rawAccount.id,
        from,
        to,
      );
      // Append raw evidence before normalization; malformed provider responses stay inspectable.
      await pool.query(
        "INSERT INTO redbark_fetches(account_id,fetched_at,raw) VALUES($1,$2,$3)",
        [
          rawAccount.id,
          fetchedAt,
          JSON.stringify({
            account: rawAccount,
            balance: rawBalance,
            transactions: rawTransactions,
            coverage: { from, to },
          }),
        ],
      );
      const balance = rawBalance?.current;
      if (
        balance &&
        (!Number.isSafeInteger(balance.amount) ||
          balance.currency.toUpperCase() !== rawAccount.currency.toUpperCase())
      )
        throw new RedbarkError("invalid_provider_balance");
      const account = {
        id: rawAccount.id,
        name: rawAccount.name || "Bank account",
        currency: rawAccount.currency.toUpperCase(),
        mode: "live",
        balanceMinor: balance ? String(balance.amount) : undefined,
        balanceType: "current",
        balanceAt: rawBalance?.observed_at,
        fetchedAt,
      };
      await store.ingestBatch({
        account,
        fetchedAt,
        coverage: {
          from,
          to,
          truncated: false,
          reason:
            "Source snapshot; opening balance and compatible coverage unavailable for reconciliation.",
        },
        transactions: rawTransactions.map((t) =>
          normalizeTransaction(t, rawAccount.id, fetchedAt),
        ),
      });
    }
  }
  async function tick() {
    if (busy || !configured()) return;
    busy = true;
    let db;
    let locked = false;
    try {
      db = await pool.connect();
      // Session lock serializes poll/webhook work across processes. Disconnect releases it.
      const lock = await db.query(
        "SELECT pg_try_advisory_lock(73426712, hashtext(current_schema())) AS acquired",
      );
      locked = lock.rows[0].acquired;
      if (!locked) return;
      const {
        rows: [state],
      } = await db.query(
        "SELECT fingerprint,next_attempt FROM redbark_state WHERE id=1",
      );
      if (
        state.fingerprint !== fingerprint ||
        (state.next_attempt &&
          new Date(state.next_attempt).getTime() > Date.now())
      )
        return;
      const bucket = Math.floor(now() / (4 * 3600000));
      await db.query(
        "INSERT INTO redbark_jobs(dedupe_key) VALUES($1) ON CONFLICT DO NOTHING",
        [`poll:${bucket}`],
      );
      const {
        rows: [job],
      } = await db.query(
        "SELECT * FROM redbark_jobs WHERE status='queued' AND available_at<=now() ORDER BY id LIMIT 1",
      );
      if (!job) return;
      try {
        await sync(job.params || {});
        await db.query(
          "UPDATE redbark_jobs SET status='completed', completed_at=now(),attempts=attempts+1,last_error=NULL WHERE id=$1",
          [job.id],
        );
        await db.query(
          "UPDATE redbark_state SET last_success=now(),last_error=NULL,next_attempt=NULL WHERE id=1",
        );
      } catch (error) {
        const code = error instanceof RedbarkError ? error.code : "sync_failed";
        const delay = Math.max(
          error.retryAfter || 0,
          Math.min(4 * 3600, 60 * 2 ** Math.min(job.attempts, 8)),
        );
        await db.query(
          "UPDATE redbark_jobs SET attempts=attempts+1,last_error=$2,available_at=now()+($3 * interval '1 second') WHERE id=$1",
          [job.id, code, delay],
        );
        await db.query(
          "UPDATE redbark_state SET last_error=$1,next_attempt=now()+($2 * interval '1 second') WHERE id=1",
          [code, delay],
        );
      }
    } finally {
      if (locked)
        await db.query(
          "SELECT pg_advisory_unlock(73426712, hashtext(current_schema()))",
        );
      db?.release();
      busy = false;
      for (const resolve of idleWaiters.splice(0)) resolve();
    }
  }
  return {
    init: () => ensureRedbarkSchema(pool),
    status,
    testConnection,
    receiveWebhook,
    tick,
    start() {
      if (!timer) {
        timer = setInterval(() => {
          tick().catch(() => {});
        }, timerIntervalMs);
        timer.unref();
      }
    },
    async stop() {
      clearInterval(timer);
      timer = undefined;
      if (busy) await new Promise((resolve) => idleWaiters.push(resolve));
    },
  };
}
