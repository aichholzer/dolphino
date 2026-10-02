import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { readTestPostgresConfig } from './helpers/postgres.mjs';
import { RedbarkClient, normalizeTransaction } from '../src/lib/redbark.mjs';
import { redbarkCategoryNames } from '../src/lib/redbark-categories.mjs';
import { createRedbarkIntegration } from '../src/lib/worker.mjs';
import { Store } from '../src/lib/store.mjs';

const database = readTestPostgresConfig();
const names = () =>
  redbarkCategoryNames([
    { id: 'cat_Food', name: 'Groceries' },
    { id: 'cat_Transfer', name: 'Moving money' }
  ]);
const raw = (id, patch = {}) => ({
  id: `txn_fk_${id}`,
  account: 'acct_A',
  amount: { amount: -1234, currency: 'aud' },
  date: '2021-03-01',
  description: `Fictional merchant ${id}`,
  status: 'posted',
  provider_category: 'FOOD_AND_DRINK',
  category: 'cat_Food',
  ...patch
});
const observation = (id, patch = {}, catalog) =>
  normalizeTransaction(raw(id, patch), patch.account || 'acct_A', '2026-01-01T00:00:00Z', catalog);
async function fixture(run) {
  const admin = new pg.Pool(database);
  const schema = `redbark_categories_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ ...database, options: `-c search_path=${schema}` });
  const store = new Store(pool, { mode: 'live' });
  try {
    await store.migrate();
    await run({ pool, store });
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
}

test('v2 taxonomy resolves opaque references without changing exact money or financial kind', () => {
  const tx = observation('expense', {}, names());
  assert.equal(tx.category, 'Groceries');
  assert.equal(tx.amountMinor, '-1234');
  assert.equal(tx.kind, 'expense');
  assert.equal(tx.raw.category, 'cat_Food');
  assert.equal(observation('unresolved').category, undefined);
  assert.equal(observation('unknown', { category: 'cat_Missing' }, names()).category, undefined);
  assert.equal(
    observation('transfer', { category: 'cat_Food', provider_category: 'TRANSFER_OUT' }, names()).kind,
    'transfer'
  );
  assert.equal(
    observation('label', { category: 'cat_Transfer' }, names()).kind,
    'expense',
    'category names never infer transfer kind'
  );
  assert.equal(observation('refund', { amount: { amount: 1234, currency: 'aud' } }, names()).kind, 'refund');
  assert.equal(
    observation('income', { provider_category: 'INCOME', amount: { amount: 1234, currency: 'aud' } }, names()).kind,
    'income'
  );
  assert.throws(() =>
    redbarkCategoryNames([
      { id: 'cat_A', name: 'One' },
      { id: 'cat_A', name: 'Other' }
    ])
  );
  assert.throws(() => redbarkCategoryNames([{ id: 'cat_A', name: ' ' }]));
  assert.throws(() => redbarkCategoryNames([{ id: 'acct_A', name: 'Wrong resource' }]));
});

test('taxonomy pagination validates every page and confines credentials to the fixed origin', async () => {
  const calls = [];
  const client = new RedbarkClient({
    apiKey: 'synthetic-key',
    fetchImpl: async (url, options) => {
      calls.push(url);
      assert.equal(options.headers.Authorization, 'Bearer synthetic-key');
      return Response.json(
        calls.length === 1
          ? {
              data: [{ id: 'cat_Food', name: 'Groceries' }],
              next_page_url: 'https://api.redbark.com/v2/categories?page=opaque'
            }
          : { data: [{ id: 'cat_Old', name: 'Archived label', archived: true }], next_page_url: null }
      );
    }
  });
  assert.deepEqual(
    [...(await client.categories())],
    [
      ['cat_Food', 'Groceries'],
      ['cat_Old', 'Archived label']
    ]
  );
  assert.equal(calls[0], 'https://api.redbark.com/v2/categories?limit=100');
  client.fetch = async () => Response.json({ data: [], next_page_url: 'https://evil.example/v2/categories' });
  await assert.rejects(client.categories(), /unsafe_provider_url/);
  client.fetch = async () => Response.json({ data: [{ id: 'cat_bad', name: '' }], next_page_url: null });
  await assert.rejects(client.categories(), /invalid_provider_categories/);
});

test(
  'historical category repair is exact, audited, idempotent and preserves manual/rule/AI evidence',
  { skip: !database },
  async () =>
    fixture(async ({ pool, store }) => {
      const legacy = async (id, patch = {}) => {
        const o = observation(id, patch);
        return store.ingest({ ...o, category: o.raw.category });
      };

      const plain = await legacy('plain');
      await store.correctTransaction(plain.id, {});
      assert.equal(
        (await store.getTransaction(plain.id)).manuallyCorrected,
        false,
        'an untouched editor save is a no-op'
      );
      assert.equal(
        (await pool.query('SELECT * FROM transaction_overrides WHERE transaction_id=$1', [plain.id])).rowCount,
        0
      );
      const manual = await legacy('manual');
      await store.correctTransaction(manual.id, {
        category: 'My food',
        kind: 'expense',
        splits: [{ category: 'My food', amountMinor: '-1234' }],
        note: 'Keep my choice'
      });
      const ruled = await legacy('ruled');
      await store.saveRule({ contains: 'merchant ruled', category: 'Rule food', kind: 'expense' });
      const ai = await legacy('ai', { category: 'cat_Unknown' });
      await pool.query("UPDATE transactions SET ai_category='Shopping' WHERE id=$1", [ai.id]);
      const transfer = await legacy('transfer', { provider_category: 'TRANSFER_OUT', category: 'cat_Transfer' });
      const identity = await legacy('identity');
      await pool.query(
        "UPDATE transactions SET review_reason='Possible pending replacement: review source identity' WHERE id=$1",
        [identity.id]
      );
      const unrelated = await legacy('other-account', { account: 'acct_B' });
      const foreign = await store.ingest({
        ...observation('other-source'),
        provider: 'other-provider',
        category: 'cat_Food'
      });
      await store.saveBudget({
        category: 'Groceries',
        currency: 'AUD',
        month: '2021-03',
        capMinor: '100',
        allocationMinor: '0',
        rollover: false
      });
      const before = await store.report({ month: '2021-03', currency: 'AUD' });
      const financialFields = async () =>
        (
          await pool.query(
            'SELECT id,mode,account_id,currency,amount_minor,status,date,description,kind,fetched_at FROM transactions ORDER BY id'
          )
        ).rows;
      const financial = await financialFields();
      const evidence = (await pool.query('SELECT id,payload,fingerprint FROM provider_observations ORDER BY id')).rows;
      const overrides = (await pool.query('SELECT * FROM transaction_overrides ORDER BY transaction_id')).rows;
      const result = await store.reconcileRedbarkCategories('acct_A', names());
      assert.equal(result.updated, 6);
      assert.equal(result.unresolved, 1);
      assert.equal((await store.getTransaction(plain.id)).category, 'Groceries');
      assert.equal((await store.getTransaction(manual.id)).category, 'My food');
      assert.equal((await store.getTransaction(ruled.id)).category, 'Rule food');
      assert.equal((await store.getTransaction(ai.id)).category, 'Shopping');
      assert.equal((await store.getTransaction(transfer.id)).kind, 'transfer');
      assert.match((await store.getTransaction(transfer.id)).reviewReason, /provider transfer/);
      assert.match((await store.getTransaction(identity.id)).reviewReason, /source identity/);
      assert.equal((await store.getTransaction(unrelated.id)).category, 'cat_Food');
      assert.equal((await store.getTransaction(foreign.id)).category, 'cat_Food');
      assert.deepEqual(
        (await pool.query('SELECT id,payload,fingerprint FROM provider_observations ORDER BY id')).rows,
        evidence
      );
      assert.deepEqual(
        (await pool.query('SELECT * FROM transaction_overrides ORDER BY transaction_id')).rows,
        overrides
      );
      const after = await store.report({ month: '2021-03', currency: 'AUD' });
      for (const key of ['incomeMinor', 'expensesMinor', 'netMinor', 'pendingMinor', 'transfersMinor']) {
        assert.equal(after[key], before[key], key);
      }

      assert.deepEqual(await financialFields(), financial);
      const alerts = (await pool.query('SELECT * FROM budget_alerts ORDER BY id')).rows;
      assert(alerts.some((a) => a.category === 'Groceries' && a.resolved_at === null));
      assert.equal((await store.reconcileRedbarkCategories('acct_A', names())).updated, 0);
      assert.deepEqual(
        (await pool.query('SELECT * FROM budget_alerts ORDER BY id')).rows,
        alerts,
        'no repeated alert revisions'
      );
      assert.equal(
        (await pool.query("SELECT * FROM audit_history WHERE action='redbark-category-resolved'")).rowCount,
        6
      );
      assert.equal(
        (await store.reconcileRedbarkCategories('acct_A', new Map())).updated,
        0,
        'taxonomy failure retains known labels and AI/rule choices'
      );
      await store.ingest({ ...observation('plain'), fetchedAt: '2026-01-02T00:00:00Z' });
      assert.equal(
        (await store.getTransaction(plain.id)).category,
        'Groceries',
        'ordinary polling also preserves a known label during taxonomy failure'
      );
    })
);

test(
  'unresolved historical references only enter existing all-history AI scanner when financial kind is safe',
  { skip: !database },
  async () =>
    fixture(async ({ pool, store }) => {
      const ids = {};
      for (const [id, patch] of Object.entries({
        safe: {},
        ambiguous: { provider_category: null },
        transfer: { provider_category: 'TRANSFER_OUT' },
        pending: { status: 'pending' },
        manual: {}
      })) {
        const o = observation(id, patch);
        ids[id] = (await store.ingest({ ...o, category: o.raw.category })).id;
      }

      await store.correctTransaction(ids.manual, { note: 'Explicit manual review' });
      await store.reconcileRedbarkCategories('acct_A', new Map());
      assert.deepEqual(
        (await store.automaticClassificationCandidates()).map((t) => t.id),
        [ids.safe]
      );
      assert.equal((await store.getTransaction(ids.safe)).reviewReason, 'Category needs review');
      assert.equal(
        (await store.listCategories()).some((c) => c.startsWith('cat_')),
        false
      );
      await pool.query("UPDATE transactions SET ai_category='Dining',review_reason=NULL WHERE id=$1", [ids.safe]);
      await store.ingest({ ...observation('safe'), fetchedAt: '2026-01-02T00:00:00Z' });
      assert.equal((await store.getTransaction(ids.safe)).category, 'Dining');
      assert.equal((await store.getTransaction(ids.safe)).reviewReason, null);
    })
);

test(
  'resolved provider names retain accepted AI evidence and use accepted posted evidence over later pending data',
  { skip: !database },
  async () =>
    fixture(async ({ pool, store }) => {
      const ai = await store.ingest(observation('mapped-ai'));
      await pool.query("UPDATE transactions SET ai_category='Dining',review_reason=NULL WHERE id=$1", [ai.id]);
      await store.reconcileRedbarkCategories('acct_A', names());
      assert.equal(
        (await store.getTransaction(ai.id)).category,
        'Groceries',
        'existing useful-provider-before-AI precedence remains'
      );
      assert.equal(
        (await pool.query('SELECT ai_category FROM transactions WHERE id=$1', [ai.id])).rows[0].ai_category,
        'Dining'
      );
      await store.ingest({ ...observation('mapped-ai', {}, names()), fetchedAt: '2026-01-02T00:00:00Z' });
      assert.equal(
        (await pool.query('SELECT ai_category FROM transactions WHERE id=$1', [ai.id])).rows[0].ai_category,
        'Dining'
      );
      assert.equal((await store.getTransaction(ai.id)).reviewReason, null);
      const posted = observation('late-pending');
      const tx = await store.ingest({ ...posted, category: posted.raw.category });
      await store.ingest({
        ...observation('late-pending', {
          status: 'pending',
          category: 'cat_Transfer',
          provider_category: 'TRANSFER_OUT'
        }),
        fetchedAt: '2026-01-03T00:00:00Z'
      });
      await store.reconcileRedbarkCategories('acct_A', names());
      const repaired = await store.getTransaction(tx.id);
      assert.equal(repaired.status, 'posted');
      assert.equal(repaired.kind, 'expense');
      assert.equal(repaired.category, 'Groceries');
      assert.equal(repaired.amountMinor, '-1234');
      await store.resolveReview(ai.id);
      await store.reconcileRedbarkCategories('acct_A', new Map());
      assert.equal((await store.getTransaction(ai.id)).reviewReason, null);
    })
);

test(
  'sync repairs old imported references outside its window; missing scope is visible and rate/credential fences remain',
  { skip: !database },
  async () =>
    fixture(async ({ pool, store }) => {
      const legacy = observation('historic');
      const old = await store.ingest({ ...legacy, category: legacy.raw.category });
      let categoryStatus = 403;
      let key = 'synthetic-key';
      let clock = Date.now();
      const calls = [];
      const integration = createRedbarkIntegration({
        pool,
        store,
        config: { mode: 'live', timezone: 'Etc/UTC' },
        now: () => clock,
        getRedbarkConfig: async () => ({ redbarkApiKey: key }),
        fetchImpl: async (url) => {
          const u = new URL(url);
          calls.push(u);
          if (u.pathname.endsWith('/categories')) {
            if (categoryStatus !== 200) {
              return Response.json(
                { error: 'Private provider details must not appear' },
                { status: categoryStatus, headers: { 'Retry-After': '600' } }
              );
            }

            return Response.json({ data: [{ id: 'cat_Food', name: 'Groceries' }], next_page_url: null });
          }

          if (u.pathname.endsWith('/balance')) {
            return Response.json({ current: { amount: 10000, currency: 'aud' } });
          }

          return Response.json({
            data: u.pathname.endsWith('/transactions')
              ? [raw('recent', { date: '2026-09-01' })]
              : [{ id: 'acct_A', name: 'Fictional', currency: 'aud', category: 'banking' }],
            next_page_url: null
          });
        }
      });
      try {
        await integration.init();
        await integration.tick();
        assert.equal(calls.length, 0, 'unverified configuration cannot read or reconcile categories');
        assert.equal((await store.getTransaction(old.id)).category, 'cat_Food');
        await integration.testConnection();
        await integration.tick();
        assert.equal((await integration.status()).categoryWarning, 'category_lookup_forbidden');
        assert.equal((await integration.status()).lastError, null);
        assert.equal((await store.listTransactions()).length, 2, 'scope failure must not prevent importing bank rows');
        assert.equal((await store.getTransaction(old.id)).category, 'Uncategorized');
        assert(
          calls
            .filter((u) => u.pathname.endsWith('/transactions'))
            .every((u) => u.searchParams.get('from') > '2021-03-01')
        );
        categoryStatus = 200;
        clock += 4 * 3600000;
        await integration.tick();
        assert.equal((await store.getTransaction(old.id)).category, 'Groceries');
        assert.equal((await integration.status()).categoryWarning, null);
        assert.equal((await store.listTransactions()).length, 2);
        assert(
          (await store.listTransactions()).every((t) => t.reviewReason === null),
          'resolved category-only reviews clear for both old and freshly reimported rows'
        );
        const recent = (await store.listTransactions()).find((t) => t.id !== old.id);
        assert(
          (
            await pool.query(
              "SELECT * FROM audit_history WHERE transaction_id=$1 AND action='redbark-category-resolved' AND before_value->>'providerCategory' IS DISTINCT FROM after_value->>'providerCategory'",
              [recent.id]
            )
          ).rowCount > 0,
          'in-window normalization changes are audited too'
        );
        categoryStatus = 403;
        clock += 4 * 3600000;
        await integration.tick();
        assert((await store.listTransactions()).every((t) => t.category === 'Groceries'));
        categoryStatus = 429;
        clock += 4 * 3600000;
        const start = calls.length;
        await integration.tick();
        assert.deepEqual(
          calls.slice(start).map((u) => u.pathname),
          ['/v2/accounts', '/v2/categories']
        );
        assert.equal((await integration.status()).lastError, 'provider_http_429');
        let stopped = calls.length;
        await integration.tick();
        assert.equal(calls.length, stopped, 'taxonomy 429 gates all jobs and provider calls');
        categoryStatus = 503;
        await pool.query('UPDATE redbark_state SET next_attempt=NULL WHERE id=1');
        await pool.query("UPDATE redbark_jobs SET available_at=now() WHERE status='queued'");
        await integration.tick();
        assert.deepEqual(
          calls.slice(stopped).map((u) => u.pathname),
          ['/v2/accounts', '/v2/categories']
        );
        assert.equal((await integration.status()).lastError, 'provider_http_503');
        stopped = calls.length;
        await integration.tick();
        assert.equal(calls.length, stopped, 'taxonomy 503 gates all jobs and provider calls');
        key = 'different-synthetic-key';
        await integration.tick();
        assert.equal((await integration.status()).verified, false);
        assert.equal(calls.length, stopped, 'credential changes cannot reuse prior verification');
      } finally {
        await integration.stop();
      }
    })
);
