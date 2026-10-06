import { readTestPostgresConfig } from './helpers/postgres.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { Store } from '../src/lib/store.mjs';
import { createSettingsStore, providerSettingsSchema } from '../src/lib/settings.mjs';
import { createClassificationIntegration } from '../src/lib/classification.mjs';

const database = readTestPostgresConfig();
async function fixture(run, max = 1) {
  const admin = new pg.Pool(database);
  const schema = `automatic_test_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({
    ...database,
    options: `-c search_path=${schema}`,
    max
  });
  const store = new Store(pool);
  const config = {
    mode: 'demo',
    llmProvider: 'openai',
    llmEnabled: true,
    llmAutoClassify: true,
    llmApiKey: 'fictional',
    llmModel: 'small',
    llmClassifyFrom: '2026-01-01'
  };
  const account = { id: 'fictional', name: 'Fictional', currency: 'AUD' };
  let sequence = 0;
  const ingest = async (patch = {}) => {
    const sourceId = patch.sourceId || `tx-${++sequence}`;
    const observation = {
      sourceId,
      accountId: account.id,
      currency: 'AUD',
      date: '2026-09-01',
      description: `Unknown shop ${sourceId}`,
      amountMinor: '-2500',
      status: 'posted',
      ...patch
    };
    await store.ingestBatch({ account, transactions: [observation] });
    return (await store.listTransactions()).find((t) => t.description === observation.description);
  };

  try {
    await store.migrate();
    await run({ pool, store, config, ingest });
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
}

const reply = (category = 'Groceries') =>
  Response.json({
    choices: [
      {
        message: {
          content: JSON.stringify({
            category,
            reason: 'Fictional category suggestion'
          })
        }
      }
    ]
  });

test('automatic classification settings default off and independently bound cost controls', () => {
  const base = { provider: 'openai', model: 'synthetic-model', region: '' };
  const defaults = providerSettingsSchema.parse(base);
  assert.equal(defaults.enabled, false);
  assert.equal(defaults.autoClassify, false);
  assert.equal(defaults.autoApply, false);
  assert.equal(defaults.dailyRequestLimit, 20);
  assert.equal(defaults.batchSize, 5);
  assert.equal(defaults.region, undefined);
  for (const patch of [
    { batchSize: 0 },
    { batchSize: 21 },
    { batchSize: 1.5 },
    { dailyRequestLimit: 0 },
    { dailyRequestLimit: 1001 },
    { dailyRequestLimit: 1.5 },
    { autoApply: 'yes' },
    { autoClassify: 'true' }
  ]) {
    assert.equal(providerSettingsSchema.safeParse({ ...base, ...patch }).success, false);
  }

  assert.equal(providerSettingsSchema.parse({ ...base, enabled: true }).autoClassify, false);
});

test(
  'automatic imports enqueue bounded deduplicated suggestions without dashboard, rules/provider/manual/pending/transfer bypass',
  { skip: !database },
  async () =>
    fixture(async ({ pool, store, config, ingest }) => {
      const wanted = await ingest();
      await store.resolveReview(wanted.id, { action: 'keep' });
      assert.equal((await store.getTransaction(wanted.id)).reviewRequired, false);
      await ingest({ status: 'pending' });
      await ingest({ category: 'Transport' });
      await ingest({ kind: 'transfer' });
      const manual = await ingest();
      await store.correctTransaction(manual.id, { category: 'Groceries' });
      await pool.query(
        "INSERT INTO rules(id,mode,contains,category,priority) VALUES($1,'demo','Ruled shop','Groceries',1)",
        [randomUUID()]
      );
      await ingest({ description: 'Ruled shop' });
      let calls = 0;
      const make = () =>
        createClassificationIntegration({
          pool,
          store,
          config,
          getProviderConfig: async () => ({ ...config }),
          fetchImpl: async (_url, options) => {
            calls++;
            const body = JSON.parse(options.body);
            assert.equal(body.max_completion_tokens, 150);
            assert.deepEqual(Object.keys(JSON.parse(body.messages[1].content)), ['description', 'categories']);
            return reply();
          }
        });
      const worker = make();
      await worker.init();
      await worker.tick();
      assert.equal(calls, 1);
      assert.equal((await store.getTransaction(wanted.id)).category, 'Uncategorized');
      assert((await store.listReviews()).some((t) => t.id === wanted.id));
      assert.equal((await worker.suggest(wanted.id)).category, 'Groceries');
      await Promise.all([worker.tick(), make().tick()]);
      assert.equal(calls, 1);
      const jobs = (await pool.query('SELECT * FROM classification_jobs')).rows;
      assert.equal(jobs.length, 1);
      assert.equal(jobs[0].origin, 'automatic');
      assert.equal(jobs[0].result.requiresReview, true);
    })
);

test(
  'opt-in automatic application persists independently, follows precedence, and creates budget alerts with dashboard closed',
  { skip: !database },
  async () =>
    fixture(async ({ pool, store, config, ingest }) => {
      config.llmAutoApply = true;
      await store.saveBudget({
        category: 'Groceries',
        currency: 'AUD',
        month: '2026-09',
        capMinor: '1000',
        allocationMinor: '0',
        rollover: false
      });
      const tx = await ingest({
        sourceId: 'stable',
        description: 'Fictional market'
      });
      const worker = createClassificationIntegration({
        pool,
        store,
        config,
        getProviderConfig: async () => ({ ...config }),
        fetchImpl: async () => reply()
      });
      await worker.init();
      await worker.tick();
      assert.equal((await store.getTransaction(tx.id)).category, 'Groceries');
      assert.equal((await pool.query('SELECT * FROM transaction_overrides')).rowCount, 0);
      assert.equal((await pool.query("SELECT * FROM audit_history WHERE action='llm-classification'")).rowCount, 1);
      assert.equal((await pool.query('SELECT * FROM budget_alerts WHERE resolved_at IS NULL')).rowCount, 1);
      await ingest({ sourceId: 'stable', description: 'Fictional market' });
      assert.equal((await store.getTransaction(tx.id)).category, 'Groceries');
      await ingest({
        sourceId: 'stable',
        description: 'Fictional market',
        category: 'Transport'
      });
      assert.equal((await store.getTransaction(tx.id)).category, 'Transport');
      assert.equal((await pool.query('SELECT * FROM budget_alerts WHERE resolved_at IS NULL')).rowCount, 0);
      await store.correctTransaction(tx.id, { category: 'Manual' });
      await worker.tick();
      assert.equal((await store.getTransaction(tx.id)).category, 'Manual');
    })
);

test(
  'automatic jobs run five per tick with no daily cap, retry invalid output, and serialize provider concurrency',
  { skip: !database },
  async () =>
    fixture(async ({ pool, store, config, ingest }) => {
      config.llmAutoApply = true;
      for (let i = 0; i < 7; i++) {
        await ingest();
      }

      let calls = 0,
        active = 0,
        maximum = 0;
      const make = () =>
        createClassificationIntegration({
          pool,
          store,
          config,
          getProviderConfig: async () => ({ ...config }),
          fetchImpl: async () => {
            calls++;
            maximum = Math.max(maximum, ++active);
            await new Promise((resolve) => setTimeout(resolve, 10));
            active--;
            return reply('Invented unsafe category');
          }
        });
      const a = make(),
        b = make();
      await a.init();
      await a.tick();
      assert.equal(calls, 5);
      await a.tick();
      assert.equal(calls, 7);
      assert.equal((await pool.query('SELECT * FROM classification_usage')).rowCount, 0);
      assert((await store.listTransactions()).every((t) => t.category === 'Uncategorized' && t.reviewRequired));
      assert.equal((await pool.query('SELECT * FROM classification_jobs WHERE attempts>0')).rowCount, 7);
      await pool.query('UPDATE classification_jobs SET next_attempt_at=now()');
      await Promise.all([a.tick(), b.tick()]);
      assert.equal(maximum, 1);
    }, 4)
);

test(
  'automatic suggestions skip transactions dated before the cutoff until older imports are included',
  { skip: !database },
  async () =>
    fixture(async ({ pool, store, config, ingest }) => {
      config.llmClassifyFrom = '2026-09-01';
      let calls = 0,
        status = 200;
      const worker = createClassificationIntegration({
        pool,
        store,
        config,
        getProviderConfig: async () => ({ ...config }),
        fetchImpl: async () => {
          calls++;
          return status === 200 ? reply() : new Response('busy', { status });
        }
      });
      await worker.init();
      const older = await ingest({ date: '2026-08-31' });
      const newer = await ingest({ date: '2026-09-01' });
      await worker.tick();
      assert.equal(calls, 1);
      const queued = async () =>
        (await pool.query('SELECT transaction_id,status FROM classification_jobs ORDER BY id')).rows;
      assert.deepEqual(await queued(), [{ transaction_id: newer.id, status: 'succeeded' }]);
      assert.equal((await store.listTransactions()).length, 2);

      // An older job queued while older imports were included waits once they are excluded.
      config.llmIncludeHistory = true;
      status = 503;
      await worker.tick();
      assert.equal(calls, 2);
      assert.equal((await queued()).find((job) => job.transaction_id === older.id).status, 'pending');
      config.llmIncludeHistory = false;
      status = 200;
      await pool.query('UPDATE classification_jobs SET next_attempt_at=now()');
      await worker.tick();
      assert.equal(calls, 2);
      config.llmIncludeHistory = true;
      await worker.tick();
      assert.equal(calls, 3);
      assert.equal((await queued()).find((job) => job.transaction_id === older.id).status, 'succeeded');
    })
);

test(
  'without a recorded cutoff nothing is queued automatically and on-demand suggestions still run',
  { skip: !database },
  async () =>
    fixture(async ({ pool, store, config, ingest }) => {
      config.llmClassifyFrom = '';
      let calls = 0;
      const worker = createClassificationIntegration({
        pool,
        store,
        config,
        getProviderConfig: async () => ({ ...config }),
        fetchImpl: async () => {
          calls++;
          return reply();
        }
      });
      await worker.init();
      const tx = await ingest({ date: '2020-01-31' });
      await worker.tick();
      assert.equal(calls, 0);
      assert.equal((await pool.query('SELECT * FROM classification_jobs')).rowCount, 0);
      assert.equal((await worker.suggest(tx.id)).category, 'Groceries');
      assert.equal(calls, 1);
    })
);

test('automatic apply rechecks manual changes during mocked provider request', { skip: !database }, async () =>
  fixture(async ({ pool, store, config, ingest }) => {
    config.llmAutoApply = true;
    const tx = await ingest();
    // Independent connection represents a concurrent user's correction, while worker holds its client.
    const other = new pg.Pool({
      ...database,
      options: pool.options.options
    });
    const otherStore = new Store(other);
    try {
      const worker = createClassificationIntegration({
        pool,
        store,
        config,
        getProviderConfig: async () => ({ ...config }),
        fetchImpl: async () => {
          await otherStore.correctTransaction(tx.id, { category: 'Manual' });
          return reply();
        }
      });
      await worker.init();
      await worker.tick();
      assert.equal((await store.getTransaction(tx.id)).category, 'Manual');
      assert.equal((await pool.query('SELECT result FROM classification_jobs')).rows[0].result.requiresReview, true);
      assert.equal((await pool.query("SELECT * FROM audit_history WHERE action='llm-classification'")).rowCount, 0);
    } finally {
      await other.end();
    }
  })
);

test(
  'automatic switch pauses durable jobs and changed source inputs create a fresh deduplicated job',
  { skip: !database },
  async () =>
    fixture(async ({ pool, store, config, ingest }) => {
      config.llmAutoApply = true;
      const tx = await ingest({
        sourceId: 'changing',
        description: 'Unknown merchant'
      });
      let calls = 0,
        fail = true;
      const worker = createClassificationIntegration({
        pool,
        store,
        config,
        getProviderConfig: async () => ({ ...config }),
        fetchImpl: async () => {
          calls++;
          return fail ? Response.json({}, { status: 503 }) : reply();
        }
      });
      await worker.init();
      await worker.tick();
      assert.equal(calls, 1);
      config.llmAutoClassify = false;
      await pool.query('UPDATE classification_jobs SET next_attempt_at=now()');
      await worker.tick();
      assert.equal(calls, 1);
      config.llmAutoClassify = true;
      fail = false;
      await worker.tick();
      assert.equal(calls, 2);
      assert.equal((await store.getTransaction(tx.id)).category, 'Groceries');
      await ingest({
        sourceId: 'changing',
        description: 'Unknown merchant',
        amountMinor: '-3500'
      });
      assert.equal((await store.getTransaction(tx.id)).category, 'Uncategorized');
      await worker.tick();
      assert.equal(calls, 3);
      assert.equal((await store.getTransaction(tx.id)).category, 'Groceries');
      assert.equal((await pool.query('SELECT * FROM classification_jobs')).rowCount, 2);
    })
);

test(
  'database-only classifier separates disabled, manual-only and automatic modes across restart',
  { skip: !database },
  async () =>
    fixture(async ({ pool, store, config, ingest }) => {
      const appSecret = randomBytes(32).toString('base64');
      const settings = createSettingsStore({
        pool,
        appSecret,
        envConfig: config
      });
      await settings.init();
      let calls = 0;
      const make = (settingsStore = settings) =>
        createClassificationIntegration({
          pool,
          store,
          config,
          // The legacy store records no cutoff; this fixture's transactions all fall after this one.
          getProviderConfig: async (client) => ({
            ...(await settingsStore.getProviderConfig(client)),
            llmClassifyFrom: '2026-01-01'
          }),
          fetchImpl: async () => {
            calls++;
            return reply();
          }
        });
      const worker = make();
      await worker.init();
      const first = await ingest();
      await worker.tick();
      await assert.rejects(worker.suggest(first.id), /disabled/);
      assert.equal(calls, 0);
      const saved = {
        provider: 'openai',
        model: 'synthetic-small',
        enabled: true,
        autoClassify: false,
        autoApply: false,
        batchSize: 2,
        dailyRequestLimit: 4
      };
      await settings.saveProvider({ ...saved, apiKey: 'synthetic-db-only' });
      await worker.tick();
      assert.equal(calls, 0);
      assert.equal((await worker.suggest(first.id)).category, 'Groceries');
      assert.equal(calls, 1);
      assert.equal((await store.getTransaction(first.id)).category, 'Uncategorized');
      await settings.saveProvider({ ...saved, autoClassify: true });
      const second = await ingest();
      await worker.tick();
      assert.equal(calls, 2);
      assert.equal((await store.getTransaction(second.id)).category, 'Uncategorized');
      await settings.saveProvider({
        ...saved,
        autoClassify: true,
        autoApply: true
      });
      const third = await ingest();
      const restarted = make(createSettingsStore({ pool, appSecret }));
      await restarted.tick();
      assert.equal(calls, 3);
      assert.equal((await store.getTransaction(third.id)).category, 'Groceries');
      await settings.saveProvider({
        ...saved,
        enabled: false,
        autoClassify: true,
        apiKey: null
      });
      await ingest();
      await restarted.tick();
      await assert.rejects(restarted.suggest(first.id), /disabled/);
      assert.equal(calls, 3);
    })
);
