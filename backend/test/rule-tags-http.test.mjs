import test from 'node:test';
import assert from 'node:assert/strict';
import { readTestPostgresConfig } from './helpers/postgres.mjs';
import { categoryFixture } from './helpers/category-fixture.mjs';
import { Store } from '../src/lib/store.mjs';

test(
  'rule tags and previews through real PostgreSQL and authorized HTTP',
  { skip: !readTestPostgresConfig() },
  async (t) => {
    const f = await categoryFixture();
    const { store, pool, json, http } = f;
    const input = { match: 'Train to conference', category: 'Travel', kind: 'expense', tags: ['Work', 'conference'] };
    const snapshot = async () => {
      const result = {};
      for (const table of [
        'rules',
        'transactions',
        'transaction_overrides',
        'transaction_tags',
        'transaction_tag_preferences',
        'audit_history',
        'provider_observations',
        'budgets'
      ]) {
        result[table] = (
          await pool.query(`SELECT row_to_json(t) value FROM ${table} t ORDER BY row_to_json(t)::text`)
        ).rows;
      }

      return result;
    };

    try {
      await t.test('unauthorized users, CSRF, strict validation and read-only preview', async () => {
        const before = await snapshot();
        for (const role of ['editor', 'viewer', 'budget', 'none', 'anonymous']) {
          const status = role === 'anonymous' ? 401 : 403;
          for (const path of ['/api/rules', '/api/rules/preview']) {
            assert.equal((await http(role, path, 'POST', input)).status, status);
          }

          assert.equal((await http(role, '/api/rules')).status, status);
          assert.equal((await http(role, `/api/rules/${f.tx.id}`, 'DELETE')).status, status);
        }

        for (const path of ['/api/rules', '/api/rules/preview']) {
          assert.equal((await http('admin', path, 'POST', input, 'https://evil.test')).status, 403);
          for (const invalid of [
            { ...input, tags: [''] },
            { ...input, tags: Array(21).fill('work') },
            { ...input, tags: ['x'.repeat(41)] },
            { ...input, tags: ['bad\u0000tag'] },
            { ...input, priority: -1 },
            { ...input, mode: 'demo' },
            { ...input, match: '' },
            { ...input, match: 'x'.repeat(201) }
          ]) {
            assert.equal((await http('admin', path, 'POST', invalid)).status, 400);
          }
        }

        const preview = await json('admin', '/api/rules/preview', 'POST', input);
        assert.equal(preview.matchingCount, 1);
        assert.deepEqual(preview.samples[0].tagsAdded, ['conference', 'work']);
        assert.equal(preview.samples[0].selectedRuleWins, true);
        assert.deepEqual(await snapshot(), before);
      });
      await t.test(
        'additive application, repeated saves and imports preserve manual corrections, exact money and immutable evidence',
        async () => {
          await store.correctTransaction(f.tx.id, {
            category: 'Groceries',
            kind: 'expense',
            note: 'Keep me',
            tags: ['personal'],
            splits: [{ category: 'Groceries', amountMinor: f.tx.amountMinor }]
          });
          const before = await snapshot();
          const totals = await store.report({ month: '2026-09', currency: 'AUD' });
          const rule = await json('admin', '/api/rules', 'POST', input);
          await json('admin', '/api/rules', 'POST', { ...input, id: rule.id });
          await json('admin', '/api/rules', 'POST', { ...input, id: rule.id, tags: undefined });
          const tx = await store.getTransaction(f.tx.id);
          assert.deepEqual(tx.tags, ['conference', 'personal', 'work']);
          assert.equal(tx.category, 'Groceries');
          assert.equal(tx.note, 'Keep me');
          assert.deepEqual(tx.splits, [{ category: 'Groceries', amountMinor: f.tx.amountMinor }]);
          assert.equal(
            (
              await pool.query("SELECT * FROM audit_history WHERE transaction_id=$1 AND action='rule-tags-added'", [
                f.tx.id
              ])
            ).rowCount,
            1
          );
          const after = await snapshot();
          for (const table of ['provider_observations', 'transaction_overrides', 'budgets']) {
            assert.deepEqual(after[table], before[table]);
          }

          const newTotals = await store.report({ month: '2026-09', currency: 'AUD' });
          for (const key of ['expensesMinor', 'incomeMinor', 'netMinor', 'transfersMinor']) {
            assert.equal(newTotals[key], totals[key]);
          }

          const fresh = { ...f.base, sourceId: 'new-train', description: 'Train to conference tomorrow' };
          const imported = await store.ingest(fresh);
          assert.deepEqual(imported.tags, ['conference', 'work']);
          await store.ingest(fresh);
          assert.equal(
            (
              await pool.query("SELECT * FROM audit_history WHERE transaction_id=$1 AND action='rule-tags-added'", [
                imported.id
              ])
            ).rowCount,
            1
          );
          await json('editor', `/api/transactions/${imported.id}`, 'PATCH', { tags: ['conference'] });
          const count = (await pool.query('SELECT count(*)::int n FROM provider_observations')).rows[0].n;
          await store.ingest(fresh);
          await store.migrate();
          await store.migrate();
          await json('admin', '/api/rules', 'POST', { ...input, id: rule.id });
          assert.deepEqual((await store.getTransaction(imported.id)).tags, ['conference']);
          assert.equal((await pool.query('SELECT count(*)::int n FROM provider_observations')).rows[0].n, count);
          const preview = await store.previewRule(input);
          assert.deepEqual(preview.samples.find((s) => s.id === imported.id).tagsSuppressed, ['work']);
          assert.equal(
            (
              await pool.query('SELECT * FROM transaction_tag_preferences WHERE transaction_id=$1 AND tag=$2', [
                imported.id,
                'conference'
              ])
            ).rowCount,
            0,
            'restart must not promote generated tags to manual tags'
          );
          await json('editor', `/api/transactions/${imported.id}`, 'PATCH', { tags: ['conference', 'work'] });
          await store.ingest(fresh);
          assert.deepEqual((await store.getTransaction(imported.id)).tags, ['conference', 'work']);
          await json('admin', `/api/rules/${rule.id}`, 'DELETE');
          assert.deepEqual((await store.getTransaction(imported.id)).tags, ['conference', 'work']);
        }
      );
      await t.test(
        'first-match priority, literal matches, capacity, concurrent writes, mode and category history',
        async () => {
          const source = { ...f.base, sourceId: 'literal', description: 'Trip 100%_\\ end' };
          const tx = await store.ingest(source);
          const low = await store.saveRule({
            match: 'Trip',
            category: 'Travel',
            kind: 'expense',
            priority: 1,
            tags: ['low']
          });
          const high = { match: '100%_\\', category: 'Travel', kind: 'expense', priority: 10, tags: ['high'] };
          const preview = await store.previewRule(high);
          assert.equal(preview.matchingCount, 1);
          assert.equal(preview.samples[0].id, tx.id);
          assert.deepEqual(preview.samples[0].tagsAdded, ['high']);
          const [one, two] = await Promise.all([store.saveRule(high), store.saveRule(high)]);
          assert.equal(one.id, two.id);
          assert.deepEqual((await store.getTransaction(tx.id)).tags, ['high', 'low']);
          assert.equal((await store.previewRule({ ...low, tags: ['ignored'] })).samples[0].selectedRuleWins, false);
          assert.deepEqual((await store.previewRule({ ...low, tags: ['ignored'] })).samples[0].tagsAdded, []);
          await store.correctTransaction(tx.id, { tags: Array.from({ length: 20 }, (_, i) => `tag-${i}`) });
          const capacity = await store.previewRule({ ...high, tags: ['extra'] });
          assert.deepEqual(capacity.samples[0].tagsAtCapacity, ['extra']);
          await store.saveRule({ ...high, tags: ['extra'] });
          assert.equal((await store.getTransaction(tx.id)).tags.length, 20);
          await store.ingest(source);
          assert.equal((await store.getTransaction(tx.id)).tags.length, 20);
          const demo = new Store(pool, { mode: 'demo' });
          await demo.saveRule({ ...high, tags: ['demo-only'] });
          assert.ok(!(await store.getTransaction(tx.id)).tags.includes('demo-only'));
          await json('admin', '/api/settings/categories', 'PATCH', { category: 'Travel', name: 'Journeys' });
          assert.equal((await store.listRules()).find((r) => r.id === one.id).categoryDisplayLabel, 'Journeys');
          await json('admin', '/api/settings/categories', 'DELETE', { category: 'Travel' });
          await store.saveRule({ ...high, tags: ['extra'] });
          assert.equal((await http('admin', '/api/rules', 'POST', { ...high, match: 'a new match' })).status, 400);
          assert.equal((await store.getTransaction(tx.id)).category, 'Travel');
          assert.equal((await store.getTransaction(tx.id)).categoryDisplayLabel, 'Journeys');
          assert.equal(
            (await pool.query('SELECT category FROM budgets WHERE id=$1', [f.budget.id])).rows[0].category,
            'Travel'
          );
        }
      );
      await t.test(
        'preview bounds its sample and stale provider payloads cannot choose a different tag rule',
        async () => {
          const rows = [];
          for (let i = 0; i < 25; i++) {
            rows.push(
              await store.ingest({
                ...f.base,
                category: 'Other',
                sourceId: `batch-${i}`,
                description: `Batch merchant literal ${i}`
              })
            );
          }

          const proposed = {
            match: 'Batch merchant literal',
            category: 'Other',
            kind: 'expense',
            priority: 100,
            tags: ['batch-tag']
          };
          const preview = await store.previewRule(proposed);
          assert.equal(preview.matchingCount, 25);
          assert.equal(preview.samples.length, 20);
          assert.ok(
            preview.samples.every((sample) => sample.selectedRuleWins && sample.tagsAdded.includes('batch-tag'))
          );
          await store.saveRule(proposed);
          await store.saveRule({
            match: 'Stale payload',
            category: 'Other',
            kind: 'expense',
            priority: 101,
            tags: ['stale-tag']
          });
          await store.ingest({
            ...f.base,
            category: 'Other',
            sourceId: 'batch-0',
            description: 'Stale payload',
            fetchedAt: '2026-09-01T00:00:00Z'
          });
          const tx = await store.getTransaction(rows[0].id);
          assert.equal(tx.description, 'Batch merchant literal 0');
          assert.deepEqual(tx.tags, ['batch-tag']);
          assert.equal(
            (
              await pool.query(
                "SELECT * FROM provider_observations WHERE transaction_id=$1 AND payload->>'description'='Stale payload'",
                [tx.id]
              )
            ).rowCount,
            1,
            'stale evidence is retained without selecting a stale rule'
          );
        }
      );
      await t.test('automatically generated private tags remain scoped in search, suggestions and export', async () => {
        await store.saveRule({
          match: 'Confidential repayment',
          category: 'Other',
          kind: 'transfer',
          tags: ['generated-transfer']
        });
        await store.saveRule({
          match: 'Hidden merchant',
          category: 'Other',
          kind: 'expense',
          tags: ['generated-hidden']
        });
        for (const tag of ['generated-transfer', 'generated-hidden']) {
          assert.equal((await json('admin', `/api/transactions?allHistory=true&tag=${tag}`)).total, 1);
          for (const role of ['editor', 'viewer']) {
            assert.equal((await json(role, `/api/transactions?allHistory=true&tag=${tag}`)).total, 0);
            assert.equal((await json(role, `/api/transactions?allHistory=true&search=${tag}`)).total, 0);
            assert.equal((await json(role, `/api/export?allHistory=true&tag=${tag}`)).transactions.length, 0);
            assert.ok(!(await json(role, '/api/tags')).tags.includes(tag));
          }
        }
      });
      await t.test(
        'pending link carries latest explicit removals and additions without changing import evidence or money',
        async () => {
          await store.saveRule({ match: 'hotel', category: 'Other', kind: 'expense', tags: ['work', 'trip'] });
          await store.correctTransaction(f.pending.id, { tags: ['trip'] });
          await store.correctTransaction(f.posted.id, { tags: [] });
          await store.correctTransaction(f.pending.id, { tags: ['trip', 'work'] });
          const evidence = (await pool.query('SELECT * FROM provider_observations ORDER BY id')).rows;
          const before = await store.report({ month: '2026-09', currency: 'AUD' });
          await json('admin', `/api/reviews/${f.posted.id}`, 'POST', { action: 'link', pendingId: f.pending.id });
          assert.deepEqual((await store.getTransaction(f.posted.id)).tags, ['work']);
          await store.saveRule({ match: 'hotel', category: 'Other', kind: 'expense', tags: ['work', 'trip'] });
          assert.deepEqual((await store.getTransaction(f.posted.id)).tags, ['work']);
          assert.equal((await store.report({ month: '2026-09', currency: 'AUD' })).expensesMinor, before.expensesMinor);
          assert.deepEqual((await pool.query('SELECT * FROM provider_observations ORDER BY id')).rows, evidence);
          await f.grant('editor', {});
          assert.equal((await json('editor', '/api/transactions?allHistory=true&tag=work')).total, 0);
          assert.deepEqual((await json('editor', '/api/tags')).tags, []);
        }
      );
    } finally {
      await f.close();
    }
  }
);
