import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { canEncrypt, decryptSecret } from "./crypto.js";
import {
  SimplefinClient,
  SimplefinError,
  claimSetupToken,
  parseSetupToken,
  parseSimplefinUrl,
  normalizeSimplefinTransaction,
} from "./simplefin-client.js";

export const SIMPLEFIN_LOCK = 71903902;
const SECRET = "simplefin.accessUrl";
const DAY = 86400;
const error = (message, status = 409) => new SimplefinError(message, status);
const hash = (value) => createHash("sha256").update(value).digest("hex");
export async function ensureSimplefinSchema(pool) {
  await pool.query(
    await readFile(
      new URL("../migrations/012_simplefin.sql", import.meta.url),
      "utf8",
    ),
  );
}
export function createSimplefinIntegration({
  pool,
  store,
  settings,
  config,
  request,
  now = Date.now,
  timerIntervalMs = 15000,
}) {
  let busy = false,
    timer;
  const idle = [];
  const clientFor = (s) => new SimplefinClient(s.accessUrl, { request });
  async function snapshot(db = pool) {
    const row = (
      await db.query(
        `SELECT
      (SELECT value FROM app_settings WHERE key='simplefin') value,
      (SELECT ciphertext FROM encrypted_credentials WHERE setting=$1 AND provider='simplefin') secret`,
        [SECRET],
      )
    ).rows[0];
    const value = { enabled: false, backfillDays: 30, ...row.value };
    let accessUrl = "",
      credentialsAvailable = true;
    if (row.secret) {
      try {
        accessUrl = decryptSecret(
          row.secret,
          config.appSecret,
          SECRET,
          "simplefin",
        );
        parseSimplefinUrl(accessUrl, true);
      } catch {
        credentialsAvailable = false;
      }
    }
    return {
      ...value,
      accessUrl,
      configured: !!row.secret,
      credentialsAvailable,
    };
  }
  async function transaction(fn) {
    const db = await pool.connect();
    try {
      await db.query("BEGIN");
      await db.query("SELECT pg_advisory_xact_lock($1)", [SIMPLEFIN_LOCK]);
      const result = await fn(db);
      await db.query("COMMIT");
      return result;
    } catch (e) {
      await db.query("ROLLBACK");
      throw e;
    } finally {
      db.release();
    }
  }
  function usable(s) {
    return config.mode === "live" && s.accessUrl && s.credentialsAvailable;
  }
  async function publicStatus() {
    const s = await snapshot();
    const state = (await pool.query("SELECT * FROM simplefin_state WHERE id=1"))
      .rows[0];
    const accounts = s.sourceId
      ? (
          await pool.query(
            "SELECT metadata,local_id,last_success FROM simplefin_accounts WHERE source_id=$1 ORDER BY metadata->>'name'",
            [s.sourceId],
          )
        ).rows.map((r) => ({
          ...r.metadata,
          localId: r.local_id,
          lastSuccess: r.last_success,
        }))
      : [];
    const counts = (
      await pool.query(
        "SELECT count(*) FILTER(WHERE status='queued' AND source_id=$1)::int queued, count(*) FILTER(WHERE status='queued' AND source_id IS DISTINCT FROM $1)::int paused FROM simplefin_jobs",
        [s.sourceId || null],
      )
    ).rows[0];
    return {
      enabled: s.enabled === true,
      configured: s.configured,
      claimPending: !!s.claimAttempt,
      credentialsAvailable: s.credentialsAvailable,
      encryptionAvailable: canEncrypt(config.appSecret),
      providerHost: s.providerHost || "",
      backfillDays: s.backfillDays,
      credential: {
        configured: s.configured,
        masked: s.configured ? "••••••••" : "",
      },
      verified:
        !!s.revision &&
        state?.tested_revision === s.revision &&
        s.credentialsAvailable,
      testedAt: state?.tested_at,
      lastSuccess: state?.last_success,
      lastError: s.claimAttempt
        ? "A previous claim did not finish locally. Disconnect locally, revoke the app connection at your provider, then generate a new token."
        : state?.last_error,
      providerErrors: state?.provider_errors || [],
      nextAttempt: state?.next_attempt,
      queuedJobs: counts.queued,
      pausedJobs: counts.paused,
      pollHours: 4,
      accounts,
      jobs: s.sourceId
        ? (
            await pool.query(
              "SELECT j.id,j.status,j.attempts,j.start_second,j.end_second,j.available_at,j.last_error,a.metadata->>'name' account_name FROM simplefin_jobs j JOIN simplefin_accounts a ON a.source_id=j.source_id AND a.remote_key=j.remote_key WHERE j.source_id=$1 ORDER BY (j.status='queued' AND j.last_error IS NOT NULL) DESC,j.id DESC LIMIT 30",
              [s.sourceId],
            )
          ).rows.map((r) => ({
            id: r.id,
            status: r.status,
            attempts: r.attempts,
            from: new Date(Number(r.start_second) * 1000).toISOString(),
            to: new Date(Number(r.end_second) * 1000).toISOString(),
            availableAt: r.available_at,
            lastError: r.last_error,
            accountName: r.account_name,
          }))
        : [],
      historicalConnections: (
        await pool.query(
          "SELECT count(DISTINCT source_id)::int n FROM simplefin_accounts WHERE local_id IS NOT NULL AND source_id IS DISTINCT FROM $1",
          [s.sourceId || null],
        )
      ).rows[0].n,
    };
  }
  async function connect(input) {
    const { token, acknowledgeAccess } = z
      .object({
        token: z.string().min(8).max(12000),
        acknowledgeAccess: z.literal(true),
      })
      .strict()
      .parse(input);
    void acknowledgeAccess;
    if (config.mode !== "live") throw error("simplefin_live_mode_required");
    settings.assertEncryptionReady();
    const claimUrl = parseSetupToken(token);
    const tokenHash = hash(claimUrl.href);
    const attempt = randomUUID();
    await transaction(async (db) => {
      const s = await snapshot(db);
      if (s.configured || s.claimAttempt)
        throw error("simplefin_disconnect_or_finish_claim_first");
      const inserted = await db.query(
        "INSERT INTO simplefin_claims(token_hash) VALUES($1) ON CONFLICT DO NOTHING RETURNING token_hash",
        [tokenHash],
      );
      if (!inserted.rowCount)
        throw error(
          "simplefin_token_already_attempted_revoke_and_generate_new",
        );
      await settings.setValue(
        "simplefin",
        {
          enabled: false,
          backfillDays: s.backfillDays,
          revision: attempt,
          claimAttempt: attempt,
        },
        db,
      );
    });
    try {
      const accessUrl = await claimSetupToken(token, { request });
      const parsed = parseSimplefinUrl(accessUrl, true);
      await transaction(async (db) => {
        const s = await snapshot(db);
        if (s.claimAttempt !== attempt)
          throw error("simplefin_claim_superseded_revoke_provider_access");
        await settings.setSecret(SECRET, "simplefin", accessUrl, db);
        await settings.setValue(
          "simplefin",
          {
            sourceId: randomUUID(),
            revision: randomUUID(),
            enabled: false,
            backfillDays: s.backfillDays,
            providerHost: parsed.url.hostname,
            providerKey: hash(parsed.url.href),
          },
          db,
        );
        await db.query(
          "UPDATE simplefin_claims SET outcome='claimed' WHERE token_hash=$1",
          [tokenHash],
        );
        await db.query(
          "UPDATE simplefin_state SET tested_revision=NULL,tested_at=NULL,last_success=NULL,last_error=NULL,provider_errors='[]',next_attempt=NULL WHERE id=1",
        );
      });
    } catch {
      // The claim may have succeeded remotely. Keep the hash durably spent even
      // on process death or database failure, and never automatically try it again.
      await transaction(async (db) => {
        const s = await snapshot(db);
        if (s.claimAttempt === attempt) {
          await settings.setValue(
            "simplefin",
            {
              enabled: false,
              backfillDays: s.backfillDays,
              revision: randomUUID(),
            },
            db,
          );
          await db.query(
            "UPDATE simplefin_state SET last_error='Claim outcome uncertain or rejected. Revoke this token or app connection at the provider, then generate a new token. Do not reuse it.' WHERE id=1",
          );
        }
      }).catch(() => {});
      throw error(
        "Claim outcome uncertain or rejected. Revoke this token or app connection at the provider, then generate a new token. Do not reuse it.",
        502,
      );
    }
    return publicStatus();
  }
  async function disconnect(input) {
    z.object({ confirm: z.literal(true) })
      .strict()
      .parse(input);
    await transaction(async (db) => {
      const s = await snapshot(db);
      await settings.clearSecret(SECRET, "simplefin", db);
      await settings.setValue(
        "simplefin",
        {
          enabled: false,
          backfillDays: s.backfillDays,
          revision: randomUUID(),
        },
        db,
      );
      await db.query(
        "UPDATE simplefin_state SET tested_revision=NULL,last_error=NULL,provider_errors='[]',next_attempt=NULL WHERE id=1",
      );
    });
    return {
      ...(await publicStatus()),
      message:
        "Disconnected locally. History is retained. Revoke this app connection in your provider's settings separately.",
    };
  }
  async function save(input) {
    const value = z
      .object({
        enabled: z.boolean(),
        backfillDays: z.number().int().min(1).max(2555),
      })
      .strict()
      .parse(input);
    await transaction(async (db) => {
      const s = await snapshot(db);
      const state = (
        await db.query("SELECT tested_revision FROM simplefin_state WHERE id=1")
      ).rows[0];
      if (value.enabled && (!usable(s) || state.tested_revision !== s.revision))
        throw error("simplefin_test_connection_before_enabling");
      const { accessUrl, configured, credentialsAvailable, ...stored } = s;
      void accessUrl;
      void configured;
      void credentialsAvailable;
      const revision = randomUUID();
      await settings.setValue(
        "simplefin",
        { ...stored, ...value, revision },
        db,
      );
      if (state.tested_revision === s.revision)
        await db.query(
          "UPDATE simplefin_state SET tested_revision=$1 WHERE id=1",
          [revision],
        );
    });
    return publicStatus();
  }
  async function assertCurrent(db, expected, { enabled = false } = {}) {
    const latest = await snapshot(db);
    if (
      latest.revision !== expected.revision ||
      latest.sourceId !== expected.sourceId ||
      !usable(latest) ||
      (enabled && !latest.enabled)
    )
      throw error("simplefin_configuration_changed_result_discarded");
    return latest;
  }
  async function discover() {
    const s = await snapshot();
    if (!usable(s)) throw error("simplefin_credentials_unavailable");
    const throttleState = (
      await pool.query(
        "SELECT next_attempt,last_error FROM simplefin_state WHERE id=1",
      )
    ).rows[0];
    if (throttleState?.last_error === "simplefin_retry_after_out_of_range")
      throw error("simplefin_retry_after_out_of_range");
    const throttle = throttleState?.next_attempt;
    if (throttle && Date.parse(throttle) > now())
      throw error("simplefin_provider_backoff_active");
    let data;
    try {
      data = await clientFor(s).accounts({ balancesOnly: true });
    } catch (e) {
      await transaction(async (db) => {
        await assertCurrent(db, s);
        await db.query(
          "UPDATE simplefin_state SET tested_revision=NULL,tested_at=now(),last_error=$1,next_attempt=CASE WHEN $2>0 THEN now()+($2*interval '1 second') ELSE next_attempt END WHERE id=1",
          [
            e instanceof SimplefinError ? e.code : "simplefin_test_failed",
            e.retryAfter || 0,
          ],
        );
      });
      throw e instanceof SimplefinError
        ? e
        : error("simplefin_test_failed", 502);
    }
    await transaction(async (db) => {
      await assertCurrent(db, s);
      for (const account of data.accounts) {
        const { transactions, raw, ...metadata } = account;
        void transactions;
        void raw;
        const prior = (
          await db.query(
            "SELECT metadata FROM simplefin_accounts WHERE source_id=$1 AND remote_key=$2",
            [s.sourceId, account.key],
          )
        ).rows[0];
        if (
          prior &&
          (prior.metadata.currency !== metadata.currency ||
            prior.metadata.redbarkId !== metadata.redbarkId)
        )
          throw error("simplefin_account_identity_changed");
        await db.query(
          "INSERT INTO simplefin_accounts(source_id,remote_key,identity_key,metadata) VALUES($1,$2,$3,$4) ON CONFLICT(source_id,remote_key) DO UPDATE SET metadata=excluded.metadata",
          [
            s.sourceId,
            account.key,
            hash(`${s.providerKey}:${account.key}`),
            metadata,
          ],
        );
      }
      await db.query(
        "UPDATE simplefin_state SET tested_revision=$1,tested_at=now(),last_error=NULL,provider_errors=$2,next_attempt=NULL WHERE id=1",
        [s.revision, JSON.stringify(data.errors)],
      );
    });
    return publicStatus();
  }
  async function enqueue(db, s, account, start, end, key) {
    // Persistent windows bound every provider call. Exact epoch boundaries are
    // inclusive start/exclusive end; adaptive splitting cannot introduce gaps.
    for (let from = start; from < end; from += 30 * DAY) {
      const to = Math.min(end, from + 30 * DAY);
      await db.query(
        "INSERT INTO simplefin_jobs(dedupe_key,source_id,remote_key,start_second,end_second) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
        [
          `${key}:${s.sourceId}:${account.key}:${from}:${to}`,
          s.sourceId,
          account.key,
          from,
          to,
        ],
      );
    }
  }
  async function mapAccount(input) {
    const { key, confirmNewAccount } = z
      .object({
        key: z.string().regex(/^[0-9a-f]{64}$/),
        confirmNewAccount: z.literal(true),
      })
      .strict()
      .parse(input);
    void confirmNewAccount;
    await transaction(async (db) => {
      const s = await snapshot(db);
      const state = (
        await db.query("SELECT tested_revision FROM simplefin_state WHERE id=1")
      ).rows[0];
      if (!usable(s) || state.tested_revision !== s.revision)
        throw error("simplefin_test_connection_before_mapping");
      const row = (
        await db.query(
          "SELECT * FROM simplefin_accounts WHERE source_id=$1 AND remote_key=$2",
          [s.sourceId, key],
        )
      ).rows[0];
      if (!row || row.metadata.unsupported)
        throw error("simplefin_account_unavailable_or_unsupported_currency");
      if (row.local_id) return;
      // Never infer a cross-source merge from names, dates or amounts. Even a
      // previous connection with the same remote ID requires reviewed migration.
      if (
        (
          await db.query(
            "SELECT 1 FROM simplefin_accounts WHERE identity_key=$1 AND local_id IS NOT NULL",
            [row.identity_key],
          )
        ).rowCount
      )
        throw error(
          "simplefin_historical_source_conflict_migration_not_supported",
        );
      const localId = row.metadata.redbarkId || `sfin_${row.identity_key}`;
      await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        "profe:live",
      ]);
      if (
        (
          await db.query("SELECT 1 FROM accounts WHERE mode='live' AND id=$1", [
            localId,
          ])
        ).rowCount
      )
        throw error(
          "simplefin_existing_account_source_conflict_migration_not_supported",
        );
      // An extra Redbark ID is only accepted from Redbark's own origin.
      if (row.metadata.redbarkId && s.providerHost !== "api.redbark.com")
        throw error("simplefin_untrusted_redbark_account_hint");
      if (
        row.metadata.redbarkId &&
        (
          await db.query(
            "SELECT 1 FROM encrypted_credentials WHERE setting='redbark.apiKey' AND provider='redbark'",
          )
        ).rowCount
      )
        throw error("simplefin_redbark_direct_source_active");
      await store.updateAccount(
        {
          ...row.metadata,
          id: localId,
          balanceType: "current",
          fetchedAt: new Date(now()).toISOString(),
        },
        null,
        db,
      );
      await db.query(
        "UPDATE simplefin_accounts SET local_id=$3,mapped_at=now() WHERE source_id=$1 AND remote_key=$2",
        [s.sourceId, key, localId],
      );
      const end = Math.floor(now() / 1000) + 1;
      await enqueue(
        db,
        s,
        row.metadata,
        end - s.backfillDays * DAY,
        end,
        "initial",
      );
    });
    return publicStatus();
  }
  async function backfill(input) {
    const v = z
      .object({
        key: z.string().regex(/^[0-9a-f]{64}$/),
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      })
      .strict()
      .parse(input);
    const start = Date.parse(v.from) / 1000,
      end = Date.parse(v.to) / 1000 + DAY;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      new Date(start * 1000).toISOString().slice(0, 10) !== v.from ||
      new Date((end - DAY) * 1000).toISOString().slice(0, 10) !== v.to ||
      start >= end ||
      end - start > 2555 * DAY ||
      start < Math.floor(now() / 1000) - 2555 * DAY ||
      end > Math.floor(now() / 1000) + DAY
    )
      throw error("simplefin_invalid_backfill_range", 400);
    await transaction(async (db) => {
      const s = await snapshot(db);
      if (!usable(s) || !s.enabled)
        throw error("simplefin_enable_before_backfill");
      const row = (
        await db.query(
          "SELECT * FROM simplefin_accounts WHERE source_id=$1 AND remote_key=$2 AND local_id IS NOT NULL",
          [s.sourceId, v.key],
        )
      ).rows[0];
      if (!row) throw error("simplefin_map_account_first");
      await enqueue(
        db,
        s,
        row.metadata,
        start,
        Math.min(end, Math.floor(now() / 1000) + 1),
        `manual:${v.from}:${v.to}`,
      );
    });
    return publicStatus();
  }
  async function tick() {
    if (busy || config.mode !== "live") return;
    busy = true;
    let db,
      locked = false;
    try {
      db = await pool.connect();
      locked = (
        await db.query(
          "SELECT pg_try_advisory_lock(73426713,hashtext(current_schema())) acquired",
        )
      ).rows[0].acquired;
      if (!locked) return;
      const s = await snapshot(db);
      if (!usable(s) || !s.enabled) return;
      const state = (await db.query("SELECT * FROM simplefin_state WHERE id=1"))
        .rows[0];
      if (
        state.tested_revision !== s.revision ||
        (state.next_attempt && Date.parse(state.next_attempt) > now())
      )
        return;
      const mapped = (
        await db.query(
          "SELECT * FROM simplefin_accounts WHERE source_id=$1 AND local_id IS NOT NULL",
          [s.sourceId],
        )
      ).rows;
      for (const row of mapped) {
        const end = Math.floor(now() / 1000) + 1;
        const start = row.last_success
          ? Math.max(
              end - 30 * DAY,
              Math.floor(Date.parse(row.last_success) / 1000) - 7 * DAY,
            )
          : end - s.backfillDays * DAY;
        const bucket = Math.floor(now() / (4 * 3600000));
        // A single durable marker per poll bucket prevents repeat polls as now changes.
        const marker = `poll:${s.sourceId}:${row.remote_key}:${bucket}`;
        await db.query(
          "INSERT INTO simplefin_jobs(dedupe_key,source_id,remote_key,start_second,end_second) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
          [
            marker,
            s.sourceId,
            row.remote_key,
            Math.max(start, end - 30 * DAY),
            end,
          ],
        );
      }
      const job = (
        await db.query(
          "SELECT * FROM simplefin_jobs WHERE status='queued' AND source_id=$1 AND available_at<=now() ORDER BY id LIMIT 1",
          [s.sourceId],
        )
      ).rows[0];
      if (!job) return;
      const mappedRow = mapped.find((r) => r.remote_key === job.remote_key);
      if (!mappedRow) return;
      const client = clientFor(s),
        start = Number(job.start_second),
        end = Number(job.end_second);
      try {
        const data = await client.accounts({
          start,
          end,
          remoteId: mappedRow.metadata.remoteId,
        });
        const account = data.accounts.find((a) => a.key === job.remote_key);
        if (!account)
          throw Object.assign(
            error("simplefin_account_missing_from_response", 502),
            { providerErrors: data.errors },
          );
        if (
          account.currency !== mappedRow.metadata.currency ||
          account.redbarkId !== mappedRow.metadata.redbarkId
        )
          throw error("simplefin_account_identity_changed", 502);
        const fetchedAt = new Date(now()).toISOString();
        const capped = account.transactions.length >= 2000;
        // Global v1 errors cannot reliably be attributed to one account. Preserve
        // returned data but mark coverage incomplete; never report full success.
        const providerErrors = [...data.errors, ...(account.errors || [])];
        const incomplete = providerErrors.length > 0;
        const transactions = [];
        const ids = new Set();
        for (const raw of account.transactions) {
          if (raw.pending === true) continue; // Posted-only MVP; never invent dates for undated pending items.
          const normalized = normalizeSimplefinTransaction(
            raw,
            { ...account, localId: mappedRow.local_id },
            {
              provider: `simplefin:${s.sourceId}`,
              fetchedAt,
              timezone: config.timezone,
              secrets: client.parsed.secrets,
            },
          );
          if (raw.posted < start || raw.posted >= end)
            throw error("simplefin_out_of_window_transaction", 502);
          if (ids.has(normalized.sourceId))
            throw error("simplefin_duplicate_transaction_identity", 502);
          ids.add(normalized.sourceId);
          transactions.push(normalized);
        }
        await transaction(async (c) => {
          await assertCurrent(c, s, { enabled: true });
          await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
            "profe:live",
          ]);
          const coverage = {
            from: new Date(start * 1000).toISOString().slice(0, 10),
            to: new Date((end - 1) * 1000).toISOString().slice(0, 10),
            startSecond: start,
            endSecond: end,
            truncated: capped || incomplete,
            reason: capped
              ? "Provider limit reached; smaller windows queued"
              : incomplete
                ? "Provider reported incomplete data; retry required"
                : "Provider-reported window; upstream completeness and opening balance cannot be independently verified",
          };
          await c.query(
            "INSERT INTO simplefin_fetches(source_id,remote_key,coverage,raw) VALUES($1,$2,$3,$4)",
            [
              s.sourceId,
              job.remote_key,
              coverage,
              {
                account: account.raw,
                normalized: {
                  account: {
                    ...account,
                    raw: undefined,
                    transactions: undefined,
                  },
                  transactions,
                },
                errors: providerErrors,
              },
            ],
          );
          await store.updateAccount(
            {
              ...account,
              id: mappedRow.local_id,
              balanceType: "current",
              fetchedAt,
            },
            coverage,
            c,
          );
          if (!capped)
            for (const tx of transactions) await store._ingest(c, tx);
          await store.refreshAlerts(c);
          if (capped || (incomplete && end - start > DAY)) {
            if (end - start <= 1)
              throw error("simplefin_limit_at_minimum_window", 502);
            const mid = start + Math.floor((end - start) / 2);
            for (const [a, b] of [
              [start, mid],
              [mid, end],
            ])
              await enqueue(c, s, account, a, b, `split:${job.id}`);
            await c.query(
              "UPDATE simplefin_jobs SET status='split',completed_at=now(),attempts=attempts+1,last_error=$2 WHERE id=$1",
              [
                job.id,
                capped
                  ? "simplefin_limit_split"
                  : "simplefin_provider_error_split",
              ],
            );
          } else if (incomplete) {
            await c.query(
              "UPDATE simplefin_jobs SET attempts=attempts+1,last_error='simplefin_provider_partial',available_at=now()+interval '4 hours' WHERE id=$1",
              [job.id],
            );
          } else {
            await c.query(
              "UPDATE simplefin_jobs SET status='completed',completed_at=now(),attempts=attempts+1,last_error=NULL WHERE id=$1",
              [job.id],
            );
            await c.query(
              "UPDATE simplefin_accounts SET last_success=now() WHERE source_id=$1 AND remote_key=$2",
              [s.sourceId, job.remote_key],
            );
          }
          await c.query(
            "UPDATE simplefin_state SET last_success=CASE WHEN $1 THEN last_success ELSE now() END,last_error=$2,provider_errors=$3,next_attempt=NULL WHERE id=1",
            [
              capped || incomplete,
              capped
                ? "simplefin_limit_split"
                : incomplete
                  ? "simplefin_provider_partial"
                  : null,
              JSON.stringify(providerErrors),
            ],
          );
        });
      } catch (e) {
        if (e.code === "simplefin_configuration_changed_result_discarded")
          return;
        if (
          [
            "simplefin_http_400",
            "simplefin_http_413",
            "simplefin_http_422",
          ].includes(e.code) &&
          end - start > DAY
        ) {
          await transaction(async (c) => {
            await assertCurrent(c, s, { enabled: true });
            const mid = start + Math.floor((end - start) / 2);
            for (const [a, b] of [
              [start, mid],
              [mid, end],
            ])
              await enqueue(c, s, mappedRow.metadata, a, b, `split:${job.id}`);
            await c.query(
              "UPDATE simplefin_jobs SET status='split',completed_at=now(),attempts=attempts+1,last_error='simplefin_rejected_window_split' WHERE id=$1",
              [job.id],
            );
            await c.query(
              "UPDATE simplefin_state SET last_error='simplefin_rejected_window_split' WHERE id=1",
            );
          });
          return;
        }
        if (e.code === "simplefin_retry_after_out_of_range") {
          await transaction(async (c) => {
            await assertCurrent(c, s, { enabled: true });
            await c.query(
              "UPDATE simplefin_state SET tested_revision=NULL,last_error='simplefin_retry_after_out_of_range' WHERE id=1",
            );
            await c.query(
              "UPDATE simplefin_jobs SET attempts=attempts+1,last_error='simplefin_retry_after_out_of_range' WHERE id=$1",
              [job.id],
            );
          });
          return;
        }
        const code =
          e instanceof SimplefinError ? e.code : "simplefin_sync_failed";
        const delay = Math.max(
          e.retryAfter || 0,
          Math.min(4 * 3600, 60 * 2 ** Math.min(job.attempts, 8)),
        );
        await transaction(async (c) => {
          await assertCurrent(c, s, { enabled: true });
          await c.query(
            "UPDATE simplefin_jobs SET attempts=attempts+1,last_error=$2,available_at=now()+($3*interval '1 second') WHERE id=$1",
            [job.id, code, delay],
          );
          await c.query(
            "UPDATE simplefin_state SET last_error=$1,next_attempt=now()+($2*interval '1 second'),provider_errors=COALESCE($3::jsonb,provider_errors) WHERE id=1",
            [
              code,
              delay,
              e.providerErrors ? JSON.stringify(e.providerErrors) : null,
            ],
          );
        });
      }
    } finally {
      if (locked)
        await db
          .query(
            "SELECT pg_advisory_unlock(73426713,hashtext(current_schema()))",
          )
          .catch(() => {});
      db?.release();
      busy = false;
      for (const resolve of idle.splice(0)) resolve();
    }
  }
  return {
    init: () => ensureSimplefinSchema(pool),
    snapshot,
    status: publicStatus,
    connect,
    disconnect,
    save,
    discover,
    mapAccount,
    backfill,
    tick,
    start() {
      if (!timer) {
        timer = setInterval(() => tick().catch(() => {}), timerIntervalMs);
        timer.unref();
      }
    },
    async stop() {
      clearInterval(timer);
      timer = undefined;
      if (busy) await new Promise((resolve) => idle.push(resolve));
    },
  };
}
