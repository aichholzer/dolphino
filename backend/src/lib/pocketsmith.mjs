import { PocketSmithClient } from './pocketsmith-client.mjs';
import { createPocketSmithSettings, safePocketSmithError } from './pocketsmith-settings.mjs';
import { pocketSmithRetryDelay } from './pocketsmith-pages.mjs';
import { preparePocketSmithImport, applyPocketSmithImport } from './pocketsmith-import.mjs';

const WORKER_LOCK = 71903903;
const DAY = 86400000;
const date = (value) => new Date(value).toISOString().slice(0, 10);
export function createPocketSmithIntegration({
  pool,
  store,
  settings,
  config,
  request,
  now = Date.now,
  timerIntervalMs = 30000
}) {
  const source = createPocketSmithSettings({ pool, store, settings, config, request, now });
  let running = null,
    timer = null;

  async function work() {
    if (config.mode !== 'live') {
      return;
    }

    const db = await pool.connect();
    let locked = false;
    try {
      locked = (await db.query('SELECT pg_try_advisory_lock($1) locked', [WORKER_LOCK])).rows[0].locked;
      if (!locked) {
        return;
      }

      const s = await source.snapshot();
      const verified = (await pool.query('SELECT tested_revision,next_attempt FROM pocketsmith_state WHERE id=1'))
        .rows[0];
      if (
        !s.enabled ||
        !s.key ||
        !s.available ||
        !s.userId ||
        verified.tested_revision !== s.revision ||
        (verified.next_attempt && Date.parse(verified.next_attempt) > now())
      ) {
        return;
      }

      const started = new Date(now()).toISOString();
      const row = (
        await pool.query(
          `SELECT *,history_from::text history_from,backfill_next::text backfill_next,
        backfill_to::text backfill_to FROM pocketsmith_accounts WHERE user_id=$1 AND enabled
        AND next_attempt <= $2 AND NOT EXISTS(SELECT 1 FROM account_tombstones WHERE mode='live' AND account_id=local_id)
        ORDER BY next_attempt,local_id LIMIT 1`,
          [s.userId, started]
        )
      ).rows[0];
      if (!row) {
        return;
      }

      try {
        const client = new PocketSmithClient(s.key, { request });
        const rawAccount = await client.account(row.native_id);
        const end = row.backfill_next
          ? date(Math.min(Date.parse(row.backfill_to), Date.parse(row.backfill_next) + 29 * DAY))
          : date(now() + DAY);
        const start = row.backfill_next ? date(row.backfill_next) : date(row.history_from);
        const batches = [
          await client.transactions({
            transactionAccountId: row.native_id,
            startDate: start,
            endDate: end,
            ...(!row.backfill_next && row.cursor
              ? { updatedSince: new Date(Date.parse(row.cursor) - 5 * 60000).toISOString() }
              : {})
          })
        ];
        if (!row.backfill_next) {
          // Reconcile a bounded recent window as well as updated_since, without
          // using absence from either result to delete or supersede anything.
          batches.push(
            await client.transactions({
              transactionAccountId: row.native_id,
              startDate: date(Math.max(Date.parse(row.history_from), now() - 30 * DAY)),
              endDate: end
            })
          );
        }

        const prepared = preparePocketSmithImport(rawAccount, batches, row, started);
        await source.transaction(async (c) => {
          await source.current(c, s, true);
          const active = (await c.query('SELECT enabled FROM pocketsmith_accounts WHERE local_id=$1', [row.local_id]))
            .rows[0];
          if (!active?.enabled) {
            return;
          }

          if (!(await applyPocketSmithImport(c, store, prepared))) {
            return;
          }

          const moreBackfill = row.backfill_next && end < date(row.backfill_to);
          await c.query(
            `UPDATE pocketsmith_accounts SET last_success=$2,last_error=NULL,attempts=0,
            backfill_next=$3,next_attempt=$4,cursor=CASE WHEN $5 THEN cursor ELSE
              GREATEST(cursor,LEAST($2::timestamptz,COALESCE((SELECT max(updated_at) FROM pocketsmith_versions WHERE account_id=$1),cursor))) END WHERE local_id=$1`,
            [
              row.local_id,
              started,
              moreBackfill ? date(Date.parse(end) + DAY) : null,
              new Date(now() + (moreBackfill || row.backfill_next ? 60000 : 4 * 3600000)).toISOString(),
              !!row.backfill_next
            ]
          );
        });
      } catch (error) {
        // An obsolete worker cannot change health, cursor or retry state after
        // a key, account selection or enabled setting has changed.
        await source.transaction(async (c) => {
          const latest = await source.snapshot(c);
          if (latest.revision !== s.revision || latest.userId !== s.userId) {
            return;
          }

          const code = safePocketSmithError(error);
          const delay = ['pocketsmith_access_denied', 'pocketsmith_retry_after_out_of_range'].includes(code)
            ? 10 * 366 * DAY
            : Math.max(error.retryAfter || 0, pocketSmithRetryDelay({}, row.attempts));
          await c.query(
            `UPDATE pocketsmith_accounts SET last_error=$2,attempts=attempts+1,next_attempt=$3 WHERE local_id=$1`,
            [row.local_id, code, new Date(now() + delay).toISOString()]
          );
          if (
            error.retryAfter ||
            code === 'pocketsmith_access_denied' ||
            code === 'pocketsmith_retry_after_out_of_range'
          ) {
            await c.query(
              `UPDATE pocketsmith_state SET last_error=$1,next_attempt=$2,
              tested_revision=CASE WHEN $3 THEN NULL ELSE tested_revision END WHERE id=1`,
              [
                code,
                error.retryAfter ? new Date(now() + delay).toISOString() : null,
                ['pocketsmith_access_denied', 'pocketsmith_retry_after_out_of_range'].includes(code)
              ]
            );
          }
        });
      }
    } finally {
      if (locked) {
        await db.query('SELECT pg_advisory_unlock($1)', [WORKER_LOCK]);
      }

      db.release();
    }
  }

  function tick() {
    if (!running) {
      running = work().finally(() => {
        running = null;
      });
    }

    return running;
  }

  return {
    status: source.status,
    save: source.save,
    discover: source.discover,
    configureAccount: (input, principal) => source.configureAccount(input, principal),
    backfill: (input, principal) => source.configureAccount(input, principal, true),
    tick,
    start() {
      if (!timer && config.mode === 'live') {
        timer = setInterval(() => {
          tick().catch(() => {});
        }, timerIntervalMs);
        timer.unref?.();
      }
    },
    async stop() {
      clearInterval(timer);
      timer = null;
      await running;
    }
  };
}
