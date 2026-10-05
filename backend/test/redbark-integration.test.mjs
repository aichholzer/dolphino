import { Store } from '../src/lib/store.mjs';
import { readTestPostgresConfig } from './helpers/postgres.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import pg from 'pg';
import { redbarkAccountFingerprint } from '../src/lib/redbark-settings.mjs';
import { createRedbarkIntegration } from '../src/lib/worker.mjs';

const database = readTestPostgresConfig();

test(
  'PostgreSQL durable webhook replay, rollback, restart and concurrent processing',
  { skip: !database },
  async () => {
    const schema = `redbark_test_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ ...database });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      ...database,
      options: `-c search_path=${schema}`
    });
    const config = {
      mode: 'live',
      redbarkApiKey: 'test-key',
      redbarkWebhookSecret: 'test-secret'
    };
    let fetches = 0;
    const fetchImpl = async () => {
      fetches++;
      return new Response(JSON.stringify({ data: [], next_page_url: null }));
    };

    const make = () =>
      createRedbarkIntegration({
        pool,
        store: { ingestBatch: async () => {} },
        config,
        getRedbarkConfig: async () => ({ ...config }),
        fetchImpl
      });
    const signed = (body) => {
      const t = Math.floor(Date.now() / 1000);
      return {
        'redbark-signature': `t=${t},v1=${createHmac('sha256', config.redbarkWebhookSecret).update(`${t}.`).update(body).digest('hex')}`
      };
    };

    try {
      const first = make();
      await first.init();
      const body = Buffer.from(
        JSON.stringify({
          id: 'evt_ABC',
          object: 'event',
          type: 'transactions.synced',
          livemode: true,
          created: new Date().toISOString()
        })
      );
      await Promise.all([first.receiveWebhook(body, signed(body)), first.receiveWebhook(body, signed(body))]);
      assert.equal((await pool.query('SELECT * FROM redbark_receipts')).rowCount, 1);
      assert.equal((await pool.query('SELECT * FROM redbark_jobs')).rowCount, 1);
      const changed = Buffer.from(body.toString().replace('transactions.synced', 'connection.created'));
      await assert.rejects(first.receiveWebhook(changed, signed(changed)), /event_id_conflict/);
      await first.tick();
      assert.equal(fetches, 0, 'no import until connection test');
      await first.testConnection();
      const restarted = make();
      await Promise.all([first.tick(), restarted.tick()]);
      assert.equal((await pool.query("SELECT * FROM redbark_jobs WHERE status='completed'")).rowCount, 1);
      assert.equal((await restarted.status()).verified, true);
      config.redbarkApiKey = 'changed-key';
      assert.equal((await make().status()).verified, false);
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  }
);

test('mocked live import preserves source evidence and Retry-After gates all jobs', { skip: !database }, async () => {
  const schema = `redbark_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ ...database });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({
    ...database,
    options: `-c search_path=${schema}`
  });
  let limited = false,
    calls = 0;
  const batches = [];
  const account = {
    id: 'acct_A',
    name: 'Fictional Everyday',
    category: 'banking',
    currency: 'aud'
  };
  const transaction = {
    id: 'txn_fk_1',
    account: 'acct_A',
    amount: { amount: -1234, currency: 'aud' },
    date: '2026-09-01',
    description: 'Fictional grocer',
    status: 'posted'
  };
  const fetchImpl = async (url) => {
    calls++;
    if (limited) {
      return new Response('{}', {
        status: 429,
        headers: { 'Retry-After': '600' }
      });
    }

    const path = new URL(url).pathname;
    const value = path.endsWith('/balance')
      ? {
          current: { amount: 10000, currency: 'aud' },
          observed_at: '2026-09-30T00:00:00Z'
        }
      : {
          data: path.endsWith('/transactions') ? [transaction] : [account],
          next_page_url: null
        };
    return new Response(JSON.stringify(value));
  };

  const store = new Store(pool, { mode: 'live' });
  await store.migrate();
  const integration = createRedbarkIntegration({
    pool,
    store: Object.assign(Object.create(store), {
      ingestBatch: async (batch) => {
        batches.push(batch);
        return store.ingestBatch(batch);
      },
      reconcileRedbarkCategories: async () => ({ updated: 0, unresolved: 0 })
    }),
    config: { mode: 'live', timezone: 'Australia/Brisbane' },
    getRedbarkConfig: async () => ({ redbarkApiKey: 'fake' }),
    fetchImpl
  });
  try {
    await integration.init();
    await integration.testConnection();
    await integration.tick();
    assert.equal(batches.length, 1);
    assert.equal(batches[0].transactions[0].amountMinor, '-1234');
    assert.equal(batches[0].account.balanceMinor, '10000');
    assert.equal((await pool.query('SELECT * FROM redbark_fetches')).rowCount, 1);
    await pool.query("INSERT INTO redbark_jobs(dedupe_key,account_fingerprint) VALUES('manual-1',$1),('manual-2',$1)", [
      redbarkAccountFingerprint('fake')
    ]);
    limited = true;
    await integration.tick();
    const afterFailure = calls;
    await integration.tick();
    assert.equal(calls, afterFailure, 'another queued job cannot evade Retry-After');
    assert.equal((await integration.status()).lastError, 'provider_http_429 on accounts');
    assert.equal((await pool.query("SELECT * FROM redbark_jobs WHERE status='queued'")).rowCount, 2);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
