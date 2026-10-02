import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { canEncrypt, decryptSecret } from './crypto.mjs';
import { PocketSmithClient, PocketSmithError, pocketSmithKey } from './pocketsmith-client.mjs';
import { normalizePocketSmithAccounts, pocketSmithDate } from './pocketsmith-data.mjs';

export const POCKETSMITH_SETTINGS_LOCK = 71903904;

const secretName = 'pocketsmith.developerKey';
const fail = (code, status = 409) => {
  throw new PocketSmithError(`pocketsmith_${code}`, status);
};

const revision = z.string().uuid().nullable();
const date = (ms) => new Date(ms).toISOString().slice(0, 10);
export const safePocketSmithError = (error) =>
  /^pocketsmith_[a-z_]+$/.test(error?.code || '') ? error.code : 'pocketsmith_operation_failed';

export function createPocketSmithSettings({ pool, store, settings, config, request, now = Date.now }) {
  async function snapshot(c = pool) {
    const row = (
      await c.query(
        `SELECT
      (SELECT value FROM app_settings WHERE key='pocketsmith') value,
      (SELECT ciphertext FROM encrypted_credentials WHERE setting=$1 AND provider='pocketsmith') secret`,
        [secretName]
      )
    ).rows[0];
    const value = { enabled: false, backfillDays: 90, revision: null, userId: null, ...row.value };
    let key = '',
      available = true;
    if (row.secret) {
      try {
        key = pocketSmithKey(decryptSecret(row.secret, config.appSecret, secretName, 'pocketsmith'));
      } catch {
        available = false;
      }
    }

    return { ...value, key, configured: !!row.secret, available };
  }

  async function transaction(work) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT pg_advisory_xact_lock($1)', [POCKETSMITH_SETTINGS_LOCK]);
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`dolphino:${store.mode}`]);
      const result = await work(c);
      await c.query('COMMIT');
      return result;
    } catch (error) {
      await c.query('ROLLBACK');
      throw error;
    } finally {
      c.release();
    }
  }

  async function actor(c, principal) {
    if (config.mode !== 'live') {
      fail('live_mode_required');
    }

    await c.query('SELECT pg_advisory_xact_lock(17092390)');
    if (
      !(await c.query("SELECT 1 FROM household_users WHERE id=$1 AND role='admin' AND NOT disabled", [principal?.id]))
        .rowCount
    ) {
      fail('administrator_required', 403);
    }
  }

  async function current(c, expected, enabled = false) {
    const state = await snapshot(c);
    if (
      state.revision !== expected.revision ||
      state.userId !== expected.userId ||
      !state.key ||
      !state.available ||
      (enabled && !state.enabled)
    ) {
      fail('configuration_changed');
    }

    return state;
  }

  async function status() {
    const s = await snapshot();
    const state = (await pool.query('SELECT * FROM pocketsmith_state WHERE id=1')).rows[0];
    const rows = s.userId
      ? (
          await pool.query(
            `SELECT p.*,p.backfill_next::text backfill_next,p.backfill_to::text backfill_to,
      a.frozen_at,a.deleted_at FROM pocketsmith_accounts p
      LEFT JOIN accounts a ON a.mode='live' AND a.id=p.local_id WHERE p.user_id=$1 AND
      NOT EXISTS(SELECT 1 FROM account_tombstones t WHERE t.mode='live' AND t.account_id=p.local_id)
      ORDER BY p.metadata->>'name'`,
            [s.userId]
          )
        ).rows
      : [];
    return {
      revision: s.revision,
      enabled: s.enabled,
      backfillDays: s.backfillDays,
      configured: s.configured,
      credentialsAvailable: s.available,
      encryptionAvailable: canEncrypt(config.appSecret),
      credential: { configured: s.configured, masked: s.configured ? '••••••••' : '' },
      verified: !!s.revision && s.available && state?.tested_revision === s.revision,
      testedAt: state?.tested_at,
      nextAttempt: state?.next_attempt,
      lastError: state?.last_error,
      pollHours: 4,
      accounts: rows.map((r) => ({
        id: r.local_id,
        nativeId: r.native_id,
        name: r.metadata.name,
        currency: r.metadata.currency,
        group: r.metadata.group,
        balanceDate: r.metadata.balanceDate,
        balanceMinor: r.metadata.balanceMinor,
        enabled: r.enabled,
        frozen: !!r.frozen_at,
        deleted: !!r.deleted_at,
        lastSuccess: r.last_success,
        lastError: r.last_error,
        nextAttempt: r.next_attempt,
        backfillNext: r.backfill_next ? date(r.backfill_next) : null,
        backfillTo: r.backfill_to ? date(r.backfill_to) : null
      }))
    };
  }

  async function save(input, principal) {
    const value = z
      .object({
        revision,
        key: z.preprocess((v) => (v === '' ? undefined : v), z.string().max(512).nullable().optional()),
        enabled: z.boolean(),
        backfillDays: z.number().int().min(1).max(2555)
      })
      .strict()
      .parse(input);
    if (value.key) {
      pocketSmithKey(value.key);
    }

    await transaction(async (c) => {
      await actor(c, principal);
      const before = await snapshot(c);
      if (before.revision !== value.revision) {
        fail('configuration_changed');
      }

      const changingKey = value.key !== undefined && (value.key !== before.key || !before.available);
      if (value.key !== undefined) {
        await settings.setSecret(secretName, 'pocketsmith', value.key, c);
      }

      const verified = (await c.query('SELECT tested_revision FROM pocketsmith_state WHERE id=1')).rows[0];
      if (
        value.enabled &&
        (changingKey || !before.key || !before.available || verified.tested_revision !== before.revision)
      ) {
        fail('test_connection_before_enabling');
      }

      const nextRevision = randomUUID();
      await settings.setValue(
        'pocketsmith',
        {
          enabled: value.enabled,
          backfillDays: value.backfillDays,
          revision: nextRevision,
          userId: changingKey ? null : before.userId
        },
        c
      );
      await c.query('UPDATE pocketsmith_state SET tested_revision=$1,last_error=NULL WHERE id=1', [
        !changingKey && verified.tested_revision === before.revision ? nextRevision : null
      ]);
    });
    return status();
  }

  async function discover(input, principal) {
    const value = z.object({ revision }).strict().parse(input);
    const s = await transaction(async (c) => {
      await actor(c, principal);
      const s = await snapshot(c);
      if (s.revision !== value.revision) {
        fail('configuration_changed');
      }

      if (!s.key || !s.available) {
        fail('credentials_unavailable');
      }

      const health = (await c.query('SELECT next_attempt FROM pocketsmith_state WHERE id=1')).rows[0];
      if (health?.next_attempt && Date.parse(health.next_attempt) > now()) {
        fail('retry_delay_active');
      }

      return s;
    });
    let discovered;
    try {
      discovered = await new PocketSmithClient(s.key, { request }).discover();
      const fetchedAt = new Date(now()).toISOString();
      discovered.accounts = normalizePocketSmithAccounts(discovered.native, discovered.groups, {
        userId: discovered.userId,
        fetchedAt
      });
      await transaction(async (c) => {
        await actor(c, principal);
        await current(c, s);
        if (s.userId && s.userId !== discovered.userId) {
          fail('source_identity_changed');
        }

        await store.atomic(
          async (c) => {
            for (const a of discovered.accounts) {
              if (
                (await c.query("SELECT 1 FROM account_tombstones WHERE mode='live' AND account_id=$1", [a.id])).rowCount
              ) {
                continue;
              }

              const previous = (await c.query('SELECT metadata FROM pocketsmith_accounts WHERE local_id=$1', [a.id]))
                .rows[0]?.metadata;
              if (previous && previous.currency !== a.currency) {
                fail('account_identity_changed');
              }

              if (previous?.balanceDate && (!a.balanceDate || a.balanceDate < previous.balanceDate)) {
                a.balanceMinor = previous.balanceMinor;
                a.balanceDate = previous.balanceDate;
                a.balanceMetadata = previous.balanceMetadata;
              }

              await c.query(
                `INSERT INTO pocketsmith_accounts(local_id,user_id,native_id,metadata) VALUES($1,$2,$3,$4)
              ON CONFLICT(local_id) DO UPDATE SET metadata=excluded.metadata`,
                [a.id, a.userId, a.remoteId, a]
              );
            }
          },
          { client: c, inTransaction: true, refresh: false }
        );
        await settings.setValue(
          'pocketsmith',
          {
            revision: s.revision,
            enabled: s.enabled,
            backfillDays: s.backfillDays,
            userId: discovered.userId
          },
          c
        );
        await c.query(
          'UPDATE pocketsmith_state SET tested_revision=$1,tested_at=$2,last_error=NULL,next_attempt=NULL WHERE id=1',
          [s.revision, fetchedAt]
        );
      });
    } catch (error) {
      await transaction(async (c) => {
        await actor(c, principal);
        await current(c, s);
        await c.query('UPDATE pocketsmith_state SET tested_revision=NULL,last_error=$1,next_attempt=$2 WHERE id=1', [
          safePocketSmithError(error),
          error.retryAfter ? new Date(now() + error.retryAfter).toISOString() : null
        ]);
      });
      throw new PocketSmithError(safePocketSmithError(error), error.status || 502);
    }

    return status();
  }

  async function configureAccount(input, principal, backfill = false) {
    const value = (
      backfill
        ? z.object({ revision, accountId: z.string().regex(/^ps_[a-f0-9]{64}$/), from: z.string(), to: z.string() })
        : z.object({ revision, accountId: z.string().regex(/^ps_[a-f0-9]{64}$/), enabled: z.boolean() })
    )
      .strict()
      .parse(input);
    if (backfill) {
      pocketSmithDate(value.from);
      pocketSmithDate(value.to);
      if (
        value.from > value.to ||
        Date.parse(value.to) - Date.parse(value.from) > 2555 * 86400000 ||
        value.to > date(now() + 86400000)
      ) {
        fail('invalid_backfill_dates', 400);
      }
    }

    await transaction(async (c) => {
      await actor(c, principal);
      const s = await snapshot(c);
      if (s.revision !== value.revision) {
        fail('configuration_changed');
      }

      await current(c, s);
      const verified = (await c.query('SELECT tested_revision FROM pocketsmith_state WHERE id=1')).rows[0];
      if (verified.tested_revision !== s.revision) {
        fail('test_connection_before_enabling');
      }

      await store.atomic(
        async (c) => {
          const row = (
            await c.query(
              `SELECT * FROM pocketsmith_accounts WHERE local_id=$1 AND user_id=$2 AND
          NOT EXISTS(SELECT 1 FROM account_tombstones WHERE mode='live' AND account_id=$1)`,
              [value.accountId, s.userId]
            )
          ).rows[0];
          if (!row) {
            fail('account_not_found', 404);
          }

          if (backfill && !row.enabled) {
            fail('enable_account_first');
          }

          if (backfill && row.backfill_next) {
            fail('backfill_already_queued');
          }

          const start = backfill ? value.from : date(now() - s.backfillDays * 86400000);
          const end = backfill ? value.to : date(now() + 86400000);
          await c.query(
            `UPDATE pocketsmith_accounts SET enabled=$2,
          history_from=CASE WHEN $3 THEN LEAST(COALESCE(history_from,$4::date),$4::date) ELSE history_from END,
          backfill_next=CASE WHEN $3 THEN $4::date ELSE backfill_next END,
          backfill_to=CASE WHEN $3 THEN $5::date ELSE backfill_to END,
          cursor=COALESCE(cursor,$4::date::timestamp AT TIME ZONE 'UTC'),next_attempt=$6,last_error=NULL,attempts=0 WHERE local_id=$1`,
            [
              row.local_id,
              backfill ? row.enabled : value.enabled,
              backfill || (value.enabled && !row.history_from),
              start,
              end,
              new Date(now()).toISOString()
            ]
          );
        },
        { client: c, inTransaction: true, refresh: false }
      );
      const nextRevision = randomUUID();
      await settings.setValue(
        'pocketsmith',
        { revision: nextRevision, enabled: s.enabled, backfillDays: s.backfillDays, userId: s.userId },
        c
      );
      await c.query('UPDATE pocketsmith_state SET tested_revision=$1 WHERE id=1', [nextRevision]);
    });
    return status();
  }

  return { status, save, discover, configureAccount, snapshot, transaction, current };
}
