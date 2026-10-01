import { readTestPostgresConfig } from './helpers/postgres.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/store.js';
import { createRedbarkIntegration } from '../src/worker.js';
import { createImportHealth, backfillSchema } from '../src/import-health.js';

const database = readTestPostgresConfig();

test('backfill validates real calendar dates, order, range and account identity', () => {
  for (const input of [
    { accountId: 'acct_A', from: '2026-02-30', to: '2026-03-01' },
    { accountId: 'acct_A', from: '2026-02-01', to: '2026-01-01' },
    { accountId: 'acct_A', from: '2000-01-01', to: '2026-01-01' },
    { accountId: 'https://evil.test', from: '2026-01-01', to: '2026-01-02' }
  ]) {
    assert.equal(backfillSchema.safeParse(input).success, false);
  }
});
test(
  'isolated PostgreSQL import health, bounded backfill, restart dedupe and Retry-After',
  { skip: !database },
  async () => {
    const admin = new pg.Pool({ ...database });
    const schema = 'health_' + randomUUID().replaceAll('-', '');
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      ...database,
      options: `-c search_path=${schema}`
    });
    const store = new Store(pool, { mode: 'live' });
    const config = {
      mode: 'live',
      redbarkApiKey: 'fictional',
      timezone: 'Australia/Brisbane'
    };
    const calls = [];
    let limited = false;
    const fetchImpl = async (input) => {
      const url = new URL(input);
      calls.push(url);
      if (limited) {
        return new Response('{}', {
          status: 429,
          headers: { 'Retry-After': '600' }
        });
      }
      if (url.pathname.endsWith('balance')) {
        return Response.json({ current: { amount: 5000, currency: 'aud' } });
      }
      return Response.json({
        data: url.pathname.endsWith('transactions')
          ? []
          : [
              { id: 'acct_A', name: 'A', currency: 'aud', category: 'banking' },
              { id: 'acct_B', name: 'B', currency: 'aud', category: 'banking' }
            ],
        next_page_url: null
      });
    };
    const integration = createRedbarkIntegration({
      pool,
      store,
      config,
      getRedbarkConfig: async () => ({ ...config }),
      fetchImpl
    });
    const make = () => createImportHealth({ pool, store, config, integration });
    try {
      await store.migrate();
      await integration.init();
      await assert.rejects(
        make().backfill({
          accountId: 'acct_A',
          from: '2026-01-01',
          to: '2026-01-31'
        }),
        /Verify/
      );
      await integration.testConnection();
      await integration.tick();
      const input = {
        accountId: 'acct_A',
        from: '2026-01-01',
        to: '2026-01-31'
      };
      const results = await Promise.all([make().backfill(input), make().backfill(input)]);
      assert.equal(results[0].job.id, results[1].job.id);
      assert.equal((await make().backfill(input)).job.id, results[0].job.id);
      calls.length = 0;
      await integration.tick();
      const txReads = calls.filter((u) => u.pathname.endsWith('transactions'));
      assert.equal(txReads.length, 1);
      assert.equal(txReads[0].searchParams.get('account'), 'acct_A');
      assert.equal(txReads[0].searchParams.get('from'), '2026-01-01');
      assert.equal(txReads[0].searchParams.get('to'), '2026-01-31');
      assert.equal((await make().status()).accounts.length, 2);
      const next = await make().backfill({ ...input, to: '2026-02-01' });
      limited = true;
      await integration.tick();
      const before = calls.length;
      const retry = await make().retry({ jobId: next.job.id });
      assert.equal(retry.job.lastError, 'provider_http_429');
      assert(new Date(retry.job.availableAt).getTime() > Date.now() + 590000);
      await integration.tick();
      assert.equal(calls.length, before);
      assert.equal((await make().status()).counts.retrying, 1);
      await assert.rejects(make().backfill({ ...input, to: '2999-01-01' }));
      await assert.rejects(make().backfill({ ...input, accountId: 'acct_unknown' }), /Account/);
    } finally {
      await integration.stop();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  }
);
