import { readTestPostgresConfig } from './helpers/postgres.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomUUID, createHmac } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { Store } from '../src/lib/store.mjs';
import { createRedbarkIntegration } from '../src/lib/worker.mjs';

const database = readTestPostgresConfig();
test(
  'running timer schedules four-hour buckets and webhook/poll share canonical identity',
  { skip: !database },
  async () => {
    const admin = new pg.Pool({ ...database });
    const schema = 'scheduler_' + randomUUID().replaceAll('-', '');
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      ...database,
      options: `-c search_path=${schema}`
    });
    const store = new Store(pool, { mode: 'live' });
    let clock = Date.parse('2026-09-30T08:00:00Z');
    let fetches = 0;
    const config = {
      mode: 'live',
      redbarkApiKey: 'fictional',
      redbarkWebhookSecret: 'fictional-signature',
      timezone: 'Australia/Brisbane'
    };
    const fetchImpl = async (url) => {
      fetches++;
      const path = new URL(url).pathname;
      return Response.json(
        path.endsWith('/balance')
          ? {
              current: { amount: 10000, currency: 'aud' },
              observed_at: '2026-09-30T08:00:00Z'
            }
          : {
              data: path.endsWith('/transactions')
                ? [
                    {
                      id: 'txn_fk_scheduler',
                      account: 'acct_scheduler',
                      amount: { amount: -1250, currency: 'aud' },
                      status: 'posted',
                      date: '2026-09-01',
                      description: 'Fictional shop',
                      provider_category: 'GENERAL_MERCHANDISE'
                    }
                  ]
                : [
                    {
                      id: 'acct_scheduler',
                      name: 'Fictional account',
                      category: 'banking',
                      currency: 'aud'
                    }
                  ],
              next_page_url: null
            }
      );
    };

    const integration = createRedbarkIntegration({
      pool,
      store,
      config,
      getRedbarkConfig: async () => ({ ...config }),
      fetchImpl,
      now: () => clock,
      timerIntervalMs: 10
    });
    async function waitJobs(count) {
      for (let n = 0; n < 200; n++) {
        const result = await pool.query("SELECT count(*)::int n FROM redbark_jobs WHERE status='completed'");
        if (result.rows[0].n === count) {
          return;
        }

        await sleep(10);
      }

      throw Error('Timer did not complete expected jobs');
    }

    try {
      await store.migrate();
      await integration.init();
      await integration.testConnection();
      integration.start();
      await waitJobs(1);
      const baseline = fetches;
      await sleep(50);
      assert.equal(fetches, baseline, 'same bucket does not fetch again');
      clock += 4 * 3600000;
      await waitJobs(2);
      assert.equal(
        (await pool.query("SELECT count(*)::int n FROM redbark_jobs WHERE dedupe_key LIKE 'poll:%'")).rows[0].n,
        2
      );
      const body = Buffer.from(
        JSON.stringify({
          id: 'evt_scheduler',
          object: 'event',
          type: 'transactions.synced',
          created: new Date().toISOString(),
          livemode: true
        })
      );
      const t = Math.floor(Date.now() / 1000);
      const signature = `t=${t},v1=${createHmac('sha256', config.redbarkWebhookSecret).update(`${t}.`).update(body).digest('hex')}`;
      await integration.receiveWebhook(body, {
        'redbark-signature': signature
      });
      await waitJobs(3);
      assert.equal((await store.listTransactions()).length, 1);
      assert.equal((await pool.query('SELECT count(*)::int n FROM source_aliases')).rows[0].n, 1);
      assert.equal((await store.report({ month: '2026-09', currency: 'AUD' })).expensesMinor, '1250');
      assert((await pool.query('SELECT count(*)::int n FROM provider_observations')).rows[0].n >= 3);
      await integration.stop();
      const stopped = fetches;
      clock += 4 * 3600000;
      await sleep(50);
      assert.equal(fetches, stopped, 'stop cancels timer');
    } finally {
      await integration.stop();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  }
);
