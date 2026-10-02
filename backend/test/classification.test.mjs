import { readTestPostgresConfig } from './helpers/postgres.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { Store } from '../src/lib/store.mjs';
import { createClassificationIntegration } from '../src/lib/classification.mjs';

test('disabled classification never creates a job or calls provider', async () => {
  const noCall = () => {
    throw Error('must not be called');
  };

  const integration = createClassificationIntegration({
    pool: { query: noCall },
    store: {},
    config: {
      llmProvider: 'openai',
      llmModel: 'ignored',
      llmApiKey: 'ignored',
      llmEnabled: true
    },
    fetchImpl: noCall
  });
  await assert.rejects(integration.suggest('test'), /disabled/);
  await integration.tick();
});

const database = readTestPostgresConfig();
test(
  'durable on-demand classification survives restart, deduplicates concurrent calls, preserves overrides and limits retries',
  { skip: !database },
  async () => {
    const admin = new pg.Pool(database);
    const schema = `classification_test_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      ...database,
      options: `-c search_path=${schema}`,
      // A worker must reuse its held client for reads, never acquire a second
      // client: the same bug deadlocks a larger pool under concurrent requests.
      max: 1,
      connectionTimeoutMillis: 1000
    });
    const store = new Store(pool, { mode: 'demo' });
    const config = {
      mode: 'demo',
      llmApiKey: 'fictional-secret-do-not-persist',
      llmProvider: 'openai',
      llmEnabled: true,
      llmModel: 'inexpensive',
      llmAutoClassify: false
    };
    let calls = 0,
      fail = true;
    const fetchImpl = async (_url, options) => {
      calls++;
      const body = JSON.parse(options.body);
      assert.equal(body.model, config.llmModel);
      assert.deepEqual(Object.keys(JSON.parse(body.messages[1].content)), ['description', 'categories']);
      if (fail) {
        return Response.json({ error: config.llmApiKey }, { status: 429, headers: { 'Retry-After': '600' } });
      }

      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                category: 'Groceries',
                reason: 'A fictional market'
              })
            }
          }
        ]
      });
    };

    const make = () =>
      createClassificationIntegration({
        pool,
        store,
        config,
        getProviderConfig: async () => ({ ...config }),
        fetchImpl
      });
    try {
      await store.migrate();
      await store.seedDemo();
      const tx = (await store.listTransactions())[0];
      await store.correctTransaction(tx.id, {
        category: 'Manual',
        note: 'Do not replace'
      });
      const first = make();
      await first.init();
      await assert.rejects(first.suggest(tx.id), /queued for retry/);
      assert.equal(calls, 1);
      await assert.rejects(first.suggest(tx.id), /queued for retry/);
      assert.equal(calls, 1, 'repeated API calls respect persisted retry time');
      let rows = (await pool.query('SELECT * FROM classification_jobs')).rows;
      assert.equal(rows.length, 1);
      assert(!JSON.stringify(rows).includes(config.llmApiKey));
      assert.equal(rows[0].attempts, 1);
      assert(
        new Date(rows[0].next_attempt_at).getTime() - Date.now() > 590000,
        'provider Retry-After persists across restart'
      );
      fail = false;
      await pool.query('UPDATE classification_jobs SET next_attempt_at=now()');
      const restarted = make();
      await Promise.all([first.tick(), restarted.tick()]);
      assert.equal(calls, 2, 'one provider call under concurrent workers');
      const result = await restarted.suggest(tx.id);
      assert.deepEqual(result, {
        category: 'Groceries',
        reason: 'A fictional market',
        requiresReview: true
      });
      assert.equal(calls, 2, 'successful result is cached');
      assert.equal((await store.getTransaction(tx.id)).category, 'Manual');
      assert.equal((await store.getTransaction(tx.id)).note, 'Do not replace');
      config.llmModel = 'different-model';
      fail = true;
      await assert.rejects(restarted.suggest(tx.id), /queued for retry/);
      for (let i = 0; i < 4; i++) {
        await pool.query("UPDATE classification_jobs SET next_attempt_at=now() WHERE status='pending'");
        await restarted.tick();
      }

      rows = (await pool.query('SELECT * FROM classification_jobs ORDER BY id')).rows;
      assert.equal(rows.length, 2, 'configuration change creates a distinct job');
      assert.equal(rows[1].attempts, 5);
      assert.equal(rows[1].status, 'failed');
      const previous = calls;
      await restarted.tick();
      assert.equal(calls, previous, 'automatic retries stop at attempt limit');
      await assert.rejects(restarted.suggest(tx.id), /queued for retry/);
      assert.equal(calls, previous + 1, 'explicit on-demand request retries a failed job');
      config.llmApiKey = 'corrected-fictional-key';
      fail = false;
      assert.equal(
        (await restarted.suggest(tx.id)).category,
        'Groceries',
        'corrected provider credentials can retry a previously failed input'
      );
      assert.equal(calls, previous + 2);
      assert(
        !JSON.stringify((await pool.query('SELECT * FROM classification_jobs')).rows).includes(config.llmApiKey),
        'rotated credentials are never persisted'
      );
      first.stop();
      restarted.stop();
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  }
);

test(
  'runtime settings load outside held clients and credential changes get fresh fingerprints',
  { skip: !database },
  async () => {
    const admin = new pg.Pool(database);
    const schema = `runtime_classification_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      ...database,
      options: `-c search_path=${schema}`,
      max: 1,
      connectionTimeoutMillis: 1000
    });
    const store = new Store(pool, { mode: 'demo' });
    let current = {
      llmProvider: 'openai',
      llmApiKey: 'synthetic',
      llmModel: 'small',
      llmEnabled: true,
      llmAutoClassify: false
    };
    let calls = 0;
    const integration = createClassificationIntegration({
      pool,
      store,
      config: { mode: 'demo' },
      getProviderConfig: async () => {
        await pool.query('SELECT 1');
        return { ...current };
      },
      fetchImpl: async () => {
        calls++;
        return Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  category: 'Groceries',
                  reason: 'Synthetic'
                })
              }
            }
          ]
        });
      }
    });
    try {
      await store.migrate();
      await store.seedDemo();
      await integration.init();
      const tx = (await store.listTransactions())[0];
      await integration.suggest(tx.id);
      assert.equal(calls, 1);
      await integration.suggest(tx.id);
      assert.equal(calls, 1);
      current.llmApiKey = 'rotated-synthetic';
      await integration.suggest(tx.id);
      assert.equal(calls, 2);
      assert.equal((await pool.query('SELECT count(*)::int n FROM classification_jobs')).rows[0].n, 2);
      await integration.suggest(tx.id);
      assert.equal(calls, 2);
      current.llmEnabled = false;
      await integration.tick();
      await assert.rejects(integration.suggest(tx.id), /disabled/);
      assert.equal(calls, 2);
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  }
);
