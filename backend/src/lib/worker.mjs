import { ensureSimplefinSchema } from './simplefin.mjs';
import { createHash } from 'node:crypto';
import { REDBARK_SETTINGS_LOCK, redbarkAccountFingerprint } from './redbark-settings.mjs';
import {
  RedbarkClient,
  RedbarkError,
  REDBARK_VERSION,
  configurationFingerprint,
  verifyRedbarkSignature,
  parseThinEvent,
  normalizeTransaction
} from './redbark.mjs';

export async function ensureRedbarkSchema(pool) {
  await ensureSimplefinSchema(pool);
  await pool.query(`CREATE TABLE IF NOT EXISTS redbark_state (id integer PRIMARY KEY CHECK(id=1), fingerprint text, tested_at timestamptz, last_success timestamptz, last_error text, next_attempt timestamptz);
    ALTER TABLE redbark_state ADD COLUMN IF NOT EXISTS next_attempt timestamptz;
    ALTER TABLE redbark_state ADD COLUMN IF NOT EXISTS category_error text;
    INSERT INTO redbark_state(id) VALUES(1) ON CONFLICT DO NOTHING;
    CREATE TABLE IF NOT EXISTS redbark_receipts (event_id text PRIMARY KEY, body bytea NOT NULL, body_hash text NOT NULL, received_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS redbark_jobs (id bigserial PRIMARY KEY, dedupe_key text UNIQUE NOT NULL, status text NOT NULL DEFAULT 'queued', attempts integer NOT NULL DEFAULT 0, available_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz, last_error text);
    ALTER TABLE redbark_jobs ADD COLUMN IF NOT EXISTS params jsonb NOT NULL DEFAULT '{}';
    ALTER TABLE redbark_jobs ADD COLUMN IF NOT EXISTS account_fingerprint text;
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
  getRedbarkConfig = async () => ({}),
  now = Date.now,
  timerIntervalMs = 15000
}) {
  async function runtime(db = pool) {
    const value = await getRedbarkConfig(db);
    return {
      ...value,
      redbarkFingerprint: configurationFingerprint(value),
      redbarkAccountFingerprint: redbarkAccountFingerprint(value.redbarkApiKey)
    };
  }

  const clientFor = (value) =>
    new RedbarkClient({
      apiKey: value.redbarkApiKey,
      version: value.redbarkVersion || REDBARK_VERSION,
      fetchImpl
    });
  let timer;
  let busy = false;
  const idleWaiters = [];
  const configured = (value) =>
    config.mode === 'live' && Boolean(value.redbarkApiKey) && !value.redbarkCredentialsUnavailable;
  async function status() {
    const current = await runtime();
    const {
      rows: [state]
    } = await pool.query('SELECT * FROM redbark_state WHERE id=1');
    const {
      rows: [counts]
    } = await pool.query(
      "SELECT count(*)::integer AS pending, count(*) FILTER(WHERE account_fingerprint IS DISTINCT FROM $1)::integer AS paused FROM redbark_jobs WHERE status='queued'",
      [current.redbarkAccountFingerprint || null]
    );
    return {
      configured: configured(current),
      verified: configured(current) && state?.fingerprint === current.redbarkFingerprint,
      version: current.redbarkVersion || REDBARK_VERSION,
      webhookConfigured: !!current.redbarkWebhookSecret,
      credentialsAvailable: !current.redbarkCredentialsUnavailable,
      testedAt: state?.tested_at,
      lastSuccess: state?.last_success,
      lastPollAt: state?.last_success,
      lastError: state?.last_error,
      categoryWarning: state?.category_error || null,
      queuedJobs: counts.pending,
      pausedJobs: counts.paused,
      pauseReason: counts.paused
        ? 'Prior-account or unbound jobs are retained and cannot run with these credentials'
        : null,
      pollHours: 4
    };
  }

  async function testConnection() {
    const current = await runtime();
    if (!configured(current)) {
      throw new RedbarkError('live_redbark_not_configured', 409);
    }

    const client = clientFor(current);
    let problem;
    try {
      const response = await client.request('accounts?limit=1');
      if (!Array.isArray(response.body?.data)) {
        throw new RedbarkError('invalid_provider_list');
      }
    } catch (error) {
      problem = error;
    }

    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      await db.query('SELECT pg_advisory_xact_lock($1)', [REDBARK_SETTINGS_LOCK]);
      const latest = await runtime(db);
      if (latest.redbarkFingerprint !== current.redbarkFingerprint) {
        throw new RedbarkError('configuration_changed_retest_required', 409);
      }

      await db.query(
        'UPDATE redbark_state SET fingerprint=$1,tested_at=now(),last_error=$2,next_attempt=NULL WHERE id=1',
        [
          problem ? null : current.redbarkFingerprint,
          problem ? (problem instanceof RedbarkError ? problem.code : 'connection_test_failed') : null
        ]
      );
      await db.query('COMMIT');
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    } finally {
      db.release();
    }

    if (problem) {
      throw problem instanceof RedbarkError ? problem : new RedbarkError('connection_test_failed');
    }

    return { ok: true, version: client.version };
  }

  async function receiveWebhook(rawBody, headers) {
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      await db.query('SELECT pg_advisory_xact_lock($1)', [REDBARK_SETTINGS_LOCK]);
      const current = await runtime(db);
      if (current.redbarkWebhookUnavailable || current.redbarkCredentialsUnavailable) {
        throw new RedbarkError('webhook_credentials_unavailable', 503);
      }

      if (!configured(current) || !current.redbarkWebhookSecret) {
        throw new RedbarkError('webhook_not_configured', 503);
      }

      if (!verifyRedbarkSignature(headers['redbark-signature'], rawBody, current.redbarkWebhookSecret)) {
        throw new RedbarkError('invalid_signature', 401);
      }

      const event = parseThinEvent(rawBody);
      const hash = createHash('sha256').update(rawBody).digest('hex');
      const inserted = await db.query(
        'INSERT INTO redbark_receipts(event_id,body,body_hash) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING event_id',
        [event.id, Buffer.from(rawBody), hash]
      );
      if (!inserted.rowCount) {
        const {
          rows: [prior]
        } = await db.query('SELECT body_hash FROM redbark_receipts WHERE event_id=$1', [event.id]);
        if (prior.body_hash !== hash) {
          throw new RedbarkError('event_id_conflict', 409);
        }
      }

      if (event.type !== 'event_destination.ping') {
        await db.query(
          'INSERT INTO redbark_jobs(dedupe_key,account_fingerprint) VALUES($1,$2) ON CONFLICT DO NOTHING',
          [`event:${event.id}`, current.redbarkAccountFingerprint]
        );
      }

      await db.query('COMMIT');
      return { accepted: true, duplicate: !inserted.rowCount };
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    } finally {
      db.release();
    }
  }

  async function sync(current, params = {}) {
    const client = clientFor(current);
    const accounts = await client.accounts();
    let categoryNames = null,
      categoryError = null;
    const timezone = config.timezone || 'Australia/Brisbane';
    const to =
      params.to ||
      new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      }).format(new Date());
    const days = Number(current.redbarkBackfillDays || 90);
    if (!Number.isInteger(days) || days < 1 || days > 2555) {
      throw new RedbarkError('invalid_backfill_days');
    }

    const from = params.from || new Date(Date.parse(to) - days * 86400000).toISOString().slice(0, 10);
    if (
      params.accountId &&
      !accounts.some((a) => a.id === params.accountId && (a.category === 'banking' || a.provider === 'documents'))
    ) {
      throw new RedbarkError('backfill_account_unavailable', 409);
    }

    for (const rawAccount of accounts) {
      if (params.accountId && rawAccount.id !== params.accountId) {
        continue;
      }

      // A deliberately mapped optional source owns its account, including while paused.
      // Never start importing its history through direct Redbark as well.
      if ((await pool.query('SELECT 1 FROM simplefin_accounts WHERE local_id=$1', [rawAccount.id])).rowCount) {
        continue;
      }

      if (rawAccount.category !== 'banking' && rawAccount.provider !== 'documents') {
        continue;
      }

      if (!/^acct_[a-zA-Z0-9]+$/.test(rawAccount.id) || !/^[a-zA-Z]{3}$/.test(rawAccount.currency)) {
        throw new RedbarkError('invalid_provider_account');
      }

      if (!categoryNames) {
        try {
          categoryNames = await client.categories();
        } catch (error) {
          categoryNames = new Map();
          categoryError = error.status === 403 ? 'category_lookup_forbidden' : 'category_lookup_unavailable';
          await pool.query('UPDATE redbark_state SET category_error=$1 WHERE id=1', [categoryError]);
          // Respect global provider backoff; missing category permission alone never blocks imports.
          if (error.status === 429 || error.status === 503) {
            throw error;
          }
        }
      }

      // Local repair must not depend on balances or the rolling transaction window.
      const historical = await store.reconcileRedbarkCategories(rawAccount.id, categoryNames);
      if (historical.unresolved && !categoryError) {
        categoryError = 'category_reference_unresolved';
      }

      await pool.query('UPDATE redbark_state SET category_error=$1 WHERE id=1', [categoryError]);
      const fetchedAt = new Date().toISOString();
      const rawBalance = rawAccount.category === 'banking' ? await client.balance(rawAccount.id) : null;
      const rawTransactions = await client.transactions(rawAccount.id, from, to);
      // Append raw evidence before normalization; malformed provider responses stay inspectable.
      await pool.query('INSERT INTO redbark_fetches(account_id,fetched_at,raw) VALUES($1,$2,$3)', [
        rawAccount.id,
        fetchedAt,
        JSON.stringify({
          account: rawAccount,
          balance: rawBalance,
          transactions: rawTransactions,
          coverage: { from, to }
        })
      ]);
      const balance = rawBalance?.current;
      if (
        balance &&
        (!Number.isSafeInteger(balance.amount) || balance.currency.toUpperCase() !== rawAccount.currency.toUpperCase())
      ) {
        throw new RedbarkError('invalid_provider_balance');
      }

      const account = {
        id: rawAccount.id,
        name: rawAccount.name || 'Bank account',
        currency: rawAccount.currency.toUpperCase(),
        mode: 'live',
        balanceMinor: balance ? String(balance.amount) : undefined,
        balanceType: 'current',
        balanceAt: rawBalance?.observed_at,
        fetchedAt
      };
      await store.ingestBatch({
        account,
        fetchedAt,
        coverage: {
          from,
          to,
          truncated: false,
          reason: 'Source snapshot; opening balance and compatible coverage unavailable for reconciliation.'
        },
        transactions: rawTransactions.map((t) => normalizeTransaction(t, rawAccount.id, fetchedAt, categoryNames))
      });
      // Repair all imported history for this verified account, including older rows
      // outside the rolling fetch window, without replaying or changing bank evidence.
      const repaired = await store.reconcileRedbarkCategories(rawAccount.id, categoryNames);
      if (repaired.unresolved && !categoryError) {
        categoryError = 'category_reference_unresolved';
      }
    }

    await pool.query('UPDATE redbark_state SET category_error=$1 WHERE id=1', [categoryError]);
  }

  async function repairCategories() {
    if (busy) {
      throw new RedbarkError('An import or category repair is already running; try again after it finishes', 409);
    }

    busy = true;
    let db,
      locked = false,
      settingsLocked = false;
    try {
      db = await pool.connect();
      locked = (await db.query('SELECT pg_try_advisory_lock(73426712, hashtext(current_schema())) AS acquired')).rows[0]
        .acquired;
      if (!locked) {
        throw new RedbarkError('An import or category repair is already running; try again after it finishes', 409);
      }

      await db.query('SELECT pg_advisory_lock($1)', [REDBARK_SETTINGS_LOCK]);
      settingsLocked = true;
      const current = await runtime(db);
      const state = (await db.query('SELECT fingerprint,next_attempt FROM redbark_state WHERE id=1')).rows[0];
      if (!configured(current) || state?.fingerprint !== current.redbarkFingerprint) {
        throw new RedbarkError('Verify the current live Redbark connection before repairing category names', 409);
      }

      if (state.next_attempt && new Date(state.next_attempt).getTime() > now()) {
        throw new RedbarkError(
          'Provider backoff is active; try category repair after ' + new Date(state.next_attempt).toISOString(),
          429
        );
      }

      const client = clientFor(current);
      let accounts, names;
      try {
        accounts = await client.accounts();
        names = await client.categories();
      } catch (error) {
        const code = error instanceof RedbarkError ? error.code : 'category_lookup_unavailable';
        const categoryError = error.status === 403 ? 'category_lookup_forbidden' : 'category_lookup_unavailable';
        await db.query('UPDATE redbark_state SET category_error=$1 WHERE id=1', [categoryError]);
        if (error.status === 429 || error.status === 503) {
          await db.query(
            "UPDATE redbark_state SET last_error=$1,next_attempt=now()+($2 * interval '1 second') WHERE id=1",
            [code, Math.max(error.retryAfter || 0, 60)]
          );
        }

        throw Object.assign(
          new RedbarkError(
            error.status === 403
              ? 'Redbark category access is unavailable. Check accounts:read and categories:read permissions, then test the connection again.'
              : 'Redbark category names could not be fetched. Stored categories were not changed; retry after provider backoff.',
            error.status === 403 ? 403 : error.status === 429 ? 429 : 502
          ),
          { expose: true }
        );
      }

      const accessible = new Set();
      for (const account of accounts) {
        if (account.category !== 'banking' && account.provider !== 'documents') {
          continue;
        }

        if (!/^acct_[a-zA-Z0-9]+$/.test(account.id) || !/^[a-zA-Z]{3}$/.test(account.currency)) {
          throw new RedbarkError('invalid_provider_account');
        }

        accessible.add(account.id);
      }

      return await store.atomic(
        async (transaction) => {
          // The settings lock also fences saves; recheck revisions for injected/runtime sources.
          const latest = await runtime(transaction);
          if (!configured(latest) || latest.redbarkFingerprint !== current.redbarkFingerprint) {
            throw new RedbarkError('configuration_changed_retest_required', 409);
          }

          const imported = (await transaction.query('SELECT id FROM accounts WHERE mode=$1', [config.mode])).rows;
          const mapped = new Set(
            (await transaction.query('SELECT local_id FROM simplefin_accounts WHERE local_id IS NOT NULL')).rows.map(
              (row) => row.local_id
            )
          );
          const eligible = imported.filter((account) => accessible.has(account.id) && !mapped.has(account.id));
          const result = {
            accounts: eligible.length,
            updated: 0,
            unresolved: 0,
            manualReferencesUpdated: 0,
            manualReferencesPreserved: 0,
            examined: 0,
            skipped: imported.length - eligible.length
          };
          for (const account of eligible) {
            const repaired = await store.reconcileRedbarkCategories(account.id, names, { client: transaction });
            for (const field of ['updated', 'unresolved', 'manualReferencesPreserved', 'examined']) {
              result[field] += repaired[field];
            }
          }

          const references = (
            await transaction.query(
              "SELECT DISTINCT p.payload->'raw'->>'category' reference FROM provider_observations p WHERE p.mode=$1 AND p.provider='redbark' AND p.account_id=ANY($2::text[])",
              [config.mode, eligible.map((account) => account.id)]
            )
          ).rows
            .map((row) => row.reference)
            .filter((reference) => reference?.startsWith('cat_'));
          result.budgetsNeedingReview = (
            await transaction.query(
              'SELECT count(*)::int count FROM budgets WHERE mode=$1 AND category=ANY($2::text[])',
              [config.mode, references]
            )
          ).rows[0].count;
          result.rulesNeedingReview = (
            await transaction.query(
              'SELECT count(*)::int count FROM rules WHERE mode=$1 AND category=ANY($2::text[])',
              [config.mode, references]
            )
          ).rows[0].count;
          await transaction.query('UPDATE redbark_state SET category_error=$1 WHERE id=1', [
            result.unresolved ? 'category_reference_unresolved' : null
          ]);
          return {
            ...result,
            message: result.unresolved
              ? 'Available category names repaired. Some names or saved category choices still need review.'
              : 'Category names repaired without reloading bank history.'
          };
        },
        { client: db }
      );
    } finally {
      if (settingsLocked) {
        await db.query('SELECT pg_advisory_unlock($1)', [REDBARK_SETTINGS_LOCK]).catch(() => {});
      }

      if (locked) {
        await db.query('SELECT pg_advisory_unlock(73426712, hashtext(current_schema()))').catch(() => {});
      }

      db?.release();
      busy = false;
      for (const resolve of idleWaiters.splice(0)) {
        resolve();
      }
    }
  }

  async function tick() {
    if (busy || config.mode !== 'live') {
      return;
    }

    busy = true;
    let db;
    let locked = false,
      settingsLocked = false;
    try {
      db = await pool.connect();
      // Session lock serializes poll/webhook work across processes. Disconnect releases it.
      const lock = await db.query('SELECT pg_try_advisory_lock(73426712, hashtext(current_schema())) AS acquired');
      locked = lock.rows[0].acquired;
      if (!locked) {
        return;
      }

      await db.query('SELECT pg_advisory_lock($1)', [REDBARK_SETTINGS_LOCK]);
      settingsLocked = true;
      const current = await runtime(db);
      if (!configured(current)) {
        return;
      }

      const {
        rows: [state]
      } = await db.query('SELECT fingerprint,next_attempt FROM redbark_state WHERE id=1');
      if (
        state.fingerprint !== current.redbarkFingerprint ||
        (state.next_attempt && new Date(state.next_attempt).getTime() > Date.now())
      ) {
        return;
      }

      const bucket = Math.floor(now() / (4 * 3600000));
      await db.query('INSERT INTO redbark_jobs(dedupe_key,account_fingerprint) VALUES($1,$2) ON CONFLICT DO NOTHING', [
        `poll:${current.redbarkAccountFingerprint}:${bucket}`,
        current.redbarkAccountFingerprint
      ]);
      const {
        rows: [job]
      } = await db.query(
        "SELECT * FROM redbark_jobs WHERE status='queued' AND available_at<=now() AND account_fingerprint=$1 ORDER BY id LIMIT 1",
        [current.redbarkAccountFingerprint]
      );
      if (!job) {
        return;
      }

      try {
        await sync(current, job.params || {});
        await db.query(
          "UPDATE redbark_jobs SET status='completed', completed_at=now(),attempts=attempts+1,last_error=NULL WHERE id=$1",
          [job.id]
        );
        await db.query('UPDATE redbark_state SET last_success=now(),last_error=NULL,next_attempt=NULL WHERE id=1');
      } catch (error) {
        const code = error instanceof RedbarkError ? error.code : 'sync_failed';
        const delay = Math.max(error.retryAfter || 0, Math.min(4 * 3600, 60 * 2 ** Math.min(job.attempts, 8)));
        await db.query(
          "UPDATE redbark_jobs SET attempts=attempts+1,last_error=$2,available_at=now()+($3 * interval '1 second') WHERE id=$1",
          [job.id, code, delay]
        );
        await db.query(
          "UPDATE redbark_state SET last_error=$1,next_attempt=now()+($2 * interval '1 second') WHERE id=1",
          [code, delay]
        );
      }
    } finally {
      if (settingsLocked) {
        await db.query('SELECT pg_advisory_unlock($1)', [REDBARK_SETTINGS_LOCK]).catch(() => {});
      }

      if (locked) {
        await db.query('SELECT pg_advisory_unlock(73426712, hashtext(current_schema()))').catch(() => {});
      }

      db?.release();
      busy = false;
      for (const resolve of idleWaiters.splice(0)) {
        resolve();
      }
    }
  }

  return {
    init: () => ensureRedbarkSchema(pool),
    status,
    testConnection,
    receiveWebhook,
    repairCategories,
    tick,
    async queueBackfill(params, key) {
      const db = await pool.connect();
      try {
        await db.query('BEGIN');
        await db.query('SELECT pg_advisory_xact_lock($1)', [REDBARK_SETTINGS_LOCK]);
        const current = await runtime(db);
        const state = (await db.query('SELECT fingerprint FROM redbark_state WHERE id=1')).rows[0];
        if (!configured(current) || state?.fingerprint !== current.redbarkFingerprint) {
          throw new RedbarkError('configuration_changed_retest_required', 409);
        }

        const result = await db.query(
          'INSERT INTO redbark_jobs(dedupe_key,params,account_fingerprint) VALUES($1,$2,$3) ON CONFLICT(dedupe_key) DO UPDATE SET dedupe_key=excluded.dedupe_key RETURNING *',
          [key + ':' + current.redbarkAccountFingerprint, params, current.redbarkAccountFingerprint]
        );
        await db.query('COMMIT');
        return result.rows[0];
      } catch (error) {
        await db.query('ROLLBACK');
        throw error;
      } finally {
        db.release();
      }
    },
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
      if (busy) {
        await new Promise((resolve) => idleWaiters.push(resolve));
      }
    }
  };
}
