import test from 'node:test';
import assert from 'node:assert/strict';
import { readTestPostgresConfig } from './helpers/postgres.mjs';
import { categoryFixture } from './helpers/category-fixture.mjs';

test(
  'category catalog, durable tags and scoped search through real PostgreSQL and HTTP',
  { skip: !readTestPostgresConfig() },
  async (t) => {
    const f = await categoryFixture();
    const { store, pool, http, json, tx, split, budget, secret, transfer } = f;
    const path = (query) => `/api/transactions?${new URLSearchParams({ allHistory: 'true', ...query })}`;
    try {
      await t.test('admin-only category mutations, origin checks and strict input boundaries', async () => {
        for (const role of ['editor', 'viewer', 'budget', 'none', 'anonymous']) {
          const expected = role === 'anonymous' ? 401 : 403;
          assert.equal((await http(role, '/api/settings/categories')).status, expected);
          for (const [method, body] of [
            ['POST', { name: 'Unauthorized' }],
            ['PATCH', { category: 'Travel', name: 'Unauthorized' }],
            ['DELETE', { category: 'Travel' }]
          ]) {
            assert.equal((await http(role, '/api/settings/categories', method, body)).status, expected);
          }
        }

        assert.equal(
          (await http('admin', '/api/settings/categories', 'POST', { name: 'CSRF' }, 'https://evil.test')).status,
          403
        );
        for (const name of ['', 'cat_private', 'bad\u0000name', 'x'.repeat(101)]) {
          assert.equal((await http('admin', '/api/settings/categories', 'POST', { name })).status, 400);
        }

        assert.equal(
          (await http('admin', '/api/settings/categories', 'POST', { name: 'Travel', shared: true })).status,
          400
        );
        assert.equal((await http('admin', '/api/settings/categories', 'POST', { name: ' travel ' })).status, 409);
        assert.equal(
          (await http('admin', '/api/settings/categories', 'DELETE', { category: 'Uncategorized' })).status,
          400
        );
        assert.equal(
          (await http('admin', '/api/settings/categories', 'PATCH', { category: 'Missing', name: 'Missing' })).status,
          404
        );
      });
      await t.test(
        'concurrent category creation serializes conflicts and catalog settings stay mode-local',
        async () => {
          const results = await Promise.all([
            http('admin', '/api/settings/categories', 'POST', { name: 'Concurrent category' }),
            http('admin', '/api/settings/categories', 'POST', { name: 'Concurrent category' })
          ]);
          assert.deepEqual(results.map((response) => response.status).sort(), [200, 409]);
          const { Store } = await import('../src/lib/store.mjs');
          const demo = new Store(pool, { mode: 'demo' });
          assert.ok(!(await demo.listCategoryCatalog()).some((entry) => entry.category === 'Concurrent category'));
          assert.deepEqual(await demo.listTags(), []);
        }
      );
      await t.test('catalog has imported and custom vocabulary without opaque IDs or hidden usage', async () => {
        await store.ingest({
          ...f.base,
          accountId: 'hidden',
          sourceId: 'neutral-transfer',
          description: 'Hidden transfer',
          kind: 'transfer',
          category: 'Transfers'
        });
        await json('admin', '/api/settings/categories', 'PATCH', {
          category: 'Transfers',
          name: 'Private neutral label'
        });
        await json('admin', '/api/settings/categories', 'POST', { name: 'Work equipment' });
        const catalog = (await json('editor', '/api/categories')).catalog;
        assert.ok(catalog.some((entry) => entry.category === 'Work equipment'));
        assert.ok(catalog.some((entry) => entry.category === 'Travel'));
        assert.ok(!JSON.stringify(catalog).includes('Secret'));
        assert.ok(!JSON.stringify(catalog).includes('Private neutral label'));
        assert.equal(catalog.find((entry) => entry.category === 'Transfers').name, 'Transfers');
        assert.ok(!JSON.stringify(catalog).includes('cat_'));
        assert.ok(
          !(await json('none', '/api/categories')).catalog.some((entry) => entry.category === 'Secret category')
        );
        await store.correctTransaction(tx.id, { category: 'User category' });
        assert.ok(
          (await json('editor', '/api/categories')).catalog.some((entry) => entry.category === 'User category')
        );
        await store.correctTransaction(tx.id, { category: 'Travel' });
      });
      await t.test(
        'multiple tags are bounded, normalized, authorized and independent of correction/review state',
        async () => {
          const before = await store.getTransaction(tx.id);
          await json('editor', `/api/transactions/${tx.id}`, 'PATCH', { tags: [' Work ', 'Conference', 'work'] });
          assert.deepEqual((await store.getTransaction(tx.id)).tags, ['conference', 'work']);
          assert.equal((await store.getTransaction(tx.id)).reviewReason, before.reviewReason);
          for (const role of ['viewer', 'budget', 'none', 'anonymous']) {
            assert.equal(
              (await http(role, `/api/transactions/${tx.id}`, 'PATCH', { tags: ['forbidden'] })).status,
              role === 'anonymous' ? 401 : 404
            );
          }

          assert.equal(
            (await http('editor', `/api/transactions/${secret.id}`, 'PATCH', { tags: ['forbidden'] })).status,
            404
          );
          for (const tags of [
            [''],
            ['x'.repeat(41)],
            Array.from({ length: 21 }, (_, n) => `tag${n}`),
            ['bad\u0000tag'],
            'work'
          ]) {
            assert.equal((await http('editor', `/api/transactions/${tx.id}`, 'PATCH', { tags })).status, 400);
          }

          assert.equal(
            (await http('editor', `/api/transactions/${tx.id}`, 'PATCH', { tags: ['work'], amountMinor: '-1' })).status,
            400
          );
          assert.deepEqual((await json('editor', '/api/tags')).tags, ['conference', 'work']);
          assert.deepEqual((await json('budget', '/api/tags')).tags, []);
          assert.deepEqual((await json('none', '/api/tags')).tags, []);
          assert.deepEqual((await json('editor', `/api/transactions/${transfer.id}`)).tags, []);
          assert.equal(
            (await http('editor', `/api/transactions/${transfer.id}`, 'PATCH', { tags: ['forbidden'] })).status,
            400
          );
          const fresh = await store.ingest({
            ...f.base,
            sourceId: 'tag-only',
            description: 'Tag only',
            category: undefined
          });
          await store.correctTransaction(fresh.id, { tags: ['one'] });
          assert.equal((await store.getTransaction(fresh.id)).manuallyCorrected, false);
          assert.equal((await store.getTransaction(fresh.id)).reviewRequired, true);
          await store.correctTransaction(fresh.id, { tags: [] });
          await store.ingest({
            ...f.base,
            sourceId: 'flight',
            description: 'Train to conference',
            fetchedAt: '2026-09-15T00:00:00Z'
          });
          assert.deepEqual((await store.getTransaction(tx.id)).tags, ['conference', 'work']);
        }
      );
      await t.test(
        'renames and archive preserve historical keys, splits, budget IDs/grants, money, evidence and manual overrides',
        async () => {
          const report = await store.report({ month: '2026-09', currency: 'AUD', months: 2 });
          const evidence = (await pool.query('SELECT * FROM provider_observations ORDER BY id')).rows;
          const overrides = (await pool.query('SELECT * FROM transaction_overrides ORDER BY transaction_id')).rows;
          const identities = (await pool.query('SELECT * FROM source_aliases ORDER BY source_id')).rows;
          await json('admin', '/api/settings/categories', 'PATCH', { category: 'Travel', name: 'Journeys' });
          const renamed = await store.getTransaction(tx.id);
          assert.equal(renamed.category, 'Travel');
          assert.equal(renamed.categoryDisplayLabel, 'Journeys');
          assert.equal((await store.getTransaction(split.id)).splits[0].categoryDisplayLabel, 'Journeys');
          assert.equal(
            (await store.listBudgets()).find((entry) => entry.id === budget.id).categoryDisplayLabel,
            'Journeys'
          );
          await json('admin', '/api/settings/categories', 'DELETE', { category: 'Travel' });
          await json('admin', '/api/settings/categories', 'DELETE', { category: 'Travel' });
          await store.migrate();
          assert.equal(
            (await json('admin', '/api/settings/categories')).catalog.find((entry) => entry.category === 'Travel')
              .archived,
            true
          );
          const after = await store.report({ month: '2026-09', currency: 'AUD', months: 2 });
          for (const key of ['expensesMinor', 'incomeMinor', 'netMinor', 'pendingMinor', 'transfersMinor']) {
            assert.equal(after[key], report[key], key);
          }

          const amounts = (report) =>
            report.monthly.map((month) =>
              month.budgets.map(({ id, spentMinor, capMinor, carryMinor, allocationMinor, remainingMinor }) => ({
                id,
                spentMinor,
                capMinor,
                carryMinor,
                allocationMinor,
                remainingMinor
              }))
            );
          assert.deepEqual(amounts(after), amounts(report));
          assert.deepEqual((await pool.query('SELECT * FROM provider_observations ORDER BY id')).rows, evidence);
          assert.deepEqual(
            (await pool.query('SELECT * FROM transaction_overrides ORDER BY transaction_id')).rows,
            overrides
          );
          assert.deepEqual((await pool.query('SELECT * FROM source_aliases ORDER BY source_id')).rows, identities);
          assert.equal(
            (await http('admin', '/api/budgets', 'PUT', { category: 'Travel', month: '2027-01', capMinor: '1000' }))
              .status,
            400
          );
          assert.equal(
            (await http('admin', `/api/transactions/${secret.id}`, 'PATCH', { category: 'Travel' })).status,
            400
          );
          await json('budget', '/api/budgets', 'PUT', {
            category: 'Travel',
            month: '2026-09',
            capMinor: '12000',
            allocationMinor: '100',
            rollover: true
          });
          assert.equal((await json('budget', '/api/budgets?month=2026-09')).budgets[0].id, budget.id);
          await json('editor', `/api/transactions/${tx.id}`, 'PATCH', {
            tags: ['conference', 'work'],
            category: 'Travel'
          });
          await json('admin', '/api/settings/categories', 'PATCH', { category: 'Travel', archived: false });
          assert.equal(
            (await json('admin', '/api/settings/categories')).catalog.find((entry) => entry.category === 'Travel').name,
            'Journeys'
          );
        }
      );
      await t.test(
        'search/filter counts and exports match all imported history with literal escaping and access fences',
        async () => {
          for (let n = 0; n < 55; n++) {
            const row = await store.ingest({
              ...f.base,
              sourceId: `paged-${n}`,
              description: `Conference ${n}`,
              date: '2026-08-10',
              category: 'Travel',
              amountMinor: '-1'
            });
            await store.correctTransaction(row.id, { tags: ['work'] });
          }

          const page = await json('editor', path({ tag: 'work', category: 'Travel', pageSize: '10', page: '2' }));
          assert.equal(page.total, 56);
          assert.equal(page.transactions.length, 10);
          const exported = await json('editor', '/api/export?allHistory=true&tag=work&category=Travel');
          assert.equal(exported.transactions.length, 56);
          assert.equal(exported.selectionSummary.expensesMinor, '12400');
          assert.equal(
            (await json('editor', path({ tag: 'work', from: '2026-09-01', to: '2026-09-30', accountId: 'visible' })))
              .total,
            1
          );
          assert.equal((await json('editor', path({ search: 'Journeys' }))).total, 57);
          assert.equal((await json('editor', path({ search: 'work' }))).total, 56);
          for (const query of [
            { search: 'Secret' },
            { search: 'Confidential' },
            { tag: 'secret-tag' },
            { tag: 'private-transfer-tag' },
            { category: 'Secret category' },
            { search: "%' OR 1=1 --" }
          ]) {
            assert.equal((await json('editor', path(query))).total, 0, JSON.stringify(query));
          }

          for (const query of [
            { search: 'x'.repeat(201) },
            { tag: 'x'.repeat(41) },
            { pageSize: '101' },
            { page: '-1' }
          ]) {
            assert.equal((await http('editor', path(query))).status, 400);
          }

          assert.equal((await http('editor', path({ accountId: 'hidden', tag: 'secret-tag' }))).status, 404);
          await store.correctTransaction(tx.id, {
            tags: ['literal%_\\', '<img src=x onerror=alert(1)>', "' or 1=1 --"]
          });
          assert.equal((await json('editor', path({ search: 'literal%_\\' }))).total, 1);
          assert.equal((await json('editor', path({ tag: "' or 1=1 --" }))).total, 1);
          assert.equal((await json('editor', path({ search: '%_' }))).total, 1);
        }
      );
      await t.test('assistant filters and exports recheck grants and never expose transfer/hidden tags', async () => {
        const args = {
          currency: 'AUD',
          from: '2026-08-01',
          to: '2026-09-30',
          accountId: null,
          merchant: null,
          category: null,
          tag: 'work',
          minAmountMinor: null,
          maxAmountMinor: null,
          status: null,
          kind: null,
          page: 1,
          pageSize: 5
        };
        const result = await json('editor', '/api/assistant/tools/finance_transactions', 'POST', args);
        assert.equal(result.data.total, 55);
        assert.ok(result.data.transactions.every((row) => row.tags.includes('work')));
        const secretResult = await json('editor', '/api/assistant/tools/finance_transactions', 'POST', {
          ...args,
          tag: 'secret-tag'
        });
        assert.equal(secretResult.data.total, 0);
        const transferResult = await json('editor', '/api/assistant/tools/finance_transaction', 'POST', {
          transactionId: transfer.id,
          currency: 'AUD'
        });
        assert.deepEqual(transferResult.data.transaction.tags, []);
        await f.grant('editor', {});
        assert.equal((await json('editor', path({ tag: 'work' }))).total, 0);
        assert.deepEqual((await json('editor', '/api/tags')).tags, []);
        assert.equal((await json('editor', '/api/export?allHistory=true&tag=work')).transactions.length, 0);
        assert.equal((await http('editor', '/api/assistant/tools/finance_transactions', 'POST', args)).status, 403);
      });
      await t.test(
        'pending linking preserves both tag sets, bounds their union and rolls back an invalid merge',
        async () => {
          await store.correctTransaction(f.pending.id, {
            tags: Array.from({ length: 20 }, (_, index) => `pending-${index}`)
          });
          await store.correctTransaction(f.posted.id, {
            tags: Array.from({ length: 20 }, (_, index) => `posted-${index}`)
          });
          const aliases = (await pool.query('SELECT * FROM source_aliases ORDER BY source_id')).rows;
          assert.equal(
            (await http('admin', `/api/reviews/${f.posted.id}`, 'POST', { action: 'link', pendingId: f.pending.id }))
              .status,
            400
          );
          assert.deepEqual((await pool.query('SELECT * FROM source_aliases ORDER BY source_id')).rows, aliases);
          assert.equal((await store.getTransaction(f.pending.id)).supersededBy, null);
          await store.correctTransaction(f.pending.id, { tags: ['pending-label', 'shared-label'] });
          await store.correctTransaction(f.posted.id, { tags: ['posted-label', 'shared-label'] });
          const before = await store.report({ month: '2026-09', currency: 'AUD' });
          await json('admin', `/api/reviews/${f.posted.id}`, 'POST', { action: 'link', pendingId: f.pending.id });
          assert.deepEqual((await store.getTransaction(f.posted.id)).tags, [
            'pending-label',
            'posted-label',
            'shared-label'
          ]);
          assert.equal((await store.getTransaction(f.pending.id)).supersededBy, f.posted.id);
          assert.equal((await store.report({ month: '2026-09', currency: 'AUD' })).expensesMinor, before.expensesMinor);
        }
      );
    } finally {
      await f.close();
    }
  }
);
