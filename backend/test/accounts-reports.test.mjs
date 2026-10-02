import { readTestPostgresConfig } from './helpers/postgres.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { Store } from '../src/lib/store.mjs';
import { calculatePeriodReport } from '../src/lib/engine.mjs';
const database = readTestPostgresConfig();
test('multi-month exact totals, monthly comparison, leap date and drilldowns', () => {
  const tx = [
    {
      id: 'a',
      currency: 'AUD',
      amountMinor: '-9007199254740993',
      status: 'posted',
      date: '2024-01-31',
      kind: 'expense',
      category: 'Groceries'
    },
    {
      id: 'b',
      currency: 'AUD',
      amountMinor: '100',
      status: 'posted',
      date: '2024-02-01',
      kind: 'refund',
      category: 'Groceries'
    },
    {
      id: 'c',
      currency: 'AUD',
      amountMinor: '-500',
      status: 'posted',
      date: '2024-02-02',
      kind: 'transfer'
    }
  ];
  const report = calculatePeriodReport(tx, [], {
    month: '2024-02',
    months: 2,
    today: '2024-02-15'
  });
  assert.equal(report.expensesMinor, '9007199254740893');
  assert.equal(report.startDate, '2024-01-01');
  assert.equal(report.endDate, '2024-02-29');
  assert.deepEqual(
    report.monthly.map((m) => m.partial),
    [false, true]
  );
  assert.deepEqual(report.transactionIds.expenses, ['a', 'b']);
  assert.equal(report.monthly[1].expensesMinor, '-100');
  assert.deepEqual(report.categories[0].transactionIds, ['a', 'b']);
  assert.throws(() => calculatePeriodReport([], [], { month: '2024-02', months: 5 }));
  for (const months of [1, 2, 3, 4, 6]) {
    assert.equal(calculatePeriodReport([], [], { month: '2024-02', months }).monthly.length, months);
  }
});
test(
  'account controls preserve history/overrides, retain all account spending, and paginate all history',
  { skip: !database },
  async () => {
    const admin = new pg.Pool(database);
    const schema = `test_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      ...database,
      options: `-c search_path=${schema}`
    });
    const store = new Store(pool, { mode: 'live' });
    try {
      await store.migrate();
      const base = {
        accountId: 'a',
        currency: 'AUD',
        amountMinor: '-1500',
        status: 'posted',
        date: '2026-09-01',
        description: 'Purchase',
        category: 'Groceries',
        kind: 'expense'
      };
      const first = await store.ingest({ ...base, sourceId: '1' });
      await store.ingest({ ...base, sourceId: '2', date: '2026-08-31' });
      await store.ingest({
        ...base,
        sourceId: 'transfer',
        kind: 'transfer',
        accountId: 'b'
      });
      await store.saveBudget({
        month: '2026-09',
        currency: 'AUD',
        category: 'Groceries',
        capMinor: '1000'
      });
      const alert = (await pool.query('SELECT * FROM budget_alerts')).rows[0];
      assert.equal(alert.amount_minor, '500');
      await store.correctTransaction(first.id, { note: 'Keep me' });
      await store.updateAccountSettings('a', {
        label: 'Local label',
        description: 'Personal account'
      });
      await store.updateAccount({
        id: 'a',
        name: 'Upstream renamed',
        currency: 'AUD'
      });
      const a = (await store.listAccounts()).find((x) => x.id === 'a');
      assert.equal(a.name, 'Local label');
      assert.equal(a.providerName, 'Upstream renamed');
      assert.equal(a.description, 'Personal account');
      assert.equal((await store.report({ month: '2026-09', months: 2 })).expensesMinor, '3000');
      assert.equal((await store.report({ month: '2026-09' })).transfersMinor, '-1500');
      assert.equal((await pool.query('SELECT * FROM budget_alerts')).rows[0].resolved_at, null);
      const page = await store.transactionPage({
        accountId: 'a',
        allHistory: true,
        month: '2026-09',
        pageSize: 1,
        page: 2
      });
      assert.equal(page.total, 2);
      assert.equal(page.transactions.length, 1);
      assert.equal(page.transactions[0].date, '2026-08-31');
      assert.equal(
        (
          await store.transactionPage({
            accountId: 'a',
            from: '2026-09-01',
            to: '2026-09-30'
          })
        ).total,
        1
      );
      const exported = await store.exportSnapshot({
        month: '2026-09',
        months: 2,
        currency: 'AUD',
        page: 2,
        pageSize: 1
      });
      assert.equal(exported.transactions.length, 3);
      assert.equal(exported.summary.expensesMinor, '3000');
      assert.equal(exported.selectionSummary.expensesMinor, '3000');
      assert.deepEqual(
        new Set(exported.summary.transactionIds.expenses),
        new Set(exported.transactions.filter((t) => t.kind === 'expense').map((t) => t.id))
      );
      const scoped = await store.exportSnapshot({
        allHistory: true,
        accountId: 'a',
        currency: 'AUD'
      });
      assert.equal(scoped.transactions.length, 2);
      assert.equal(scoped.summary.expensesMinor, '3000');
      const ranged = await store.exportSnapshot({
        from: '2026-08-31',
        to: '2026-09-01',
        accountId: 'a',
        currency: 'AUD'
      });
      assert.equal(ranged.transactions.length, 2);
      assert.equal(ranged.selectionSummary.expensesMinor, '3000');
      const empty = await store.exportSnapshot({
        month: '2026-09',
        months: 2,
        currency: 'AUD',
        ids: []
      });
      assert.equal(empty.selectionSummary.expensesMinor, '0');
      assert.equal(empty.summary.expensesMinor, '3000');
      await assert.rejects(store.transactionPage({ from: '2026-02-30' }));
      await assert.rejects(store.updateAccountSettings('a', { enabled: 'false' }));
      assert.equal((await store.getTransaction(first.id)).note, 'Keep me');
      assert.equal((await store.listTransactions({ accountId: 'b' }))[0].kind, 'transfer');
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  }
);

test(
  'notification transitions are durable atomic and deduplicated without report reads',
  { skip: !database },
  async () => {
    const admin = new pg.Pool(database);
    const schema = `test_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      ...database,
      options: `-c search_path=${schema}`
    });
    const store = new Store(pool, { mode: 'live' });
    try {
      await store.migrate();
      const tx = await store.ingest({
        accountId: 'a',
        sourceId: 'purchase',
        currency: 'AUD',
        amountMinor: '-1500',
        date: '2026-09-01',
        status: 'posted',
        description: 'Fictional',
        category: 'Groceries',
        kind: 'expense'
      });
      const budget = {
        month: '2026-09',
        currency: 'AUD',
        category: 'Groceries',
        capMinor: '1000'
      };
      const events = async () => (await pool.query('SELECT * FROM notification_events ORDER BY id')).rows;
      await store.saveBudget(budget);
      await store.saveBudget(budget);
      assert.equal((await events()).length, 1);
      await store.saveBudget({ ...budget, capMinor: '900' });
      assert.equal((await events()).length, 1);
      await store.correctTransaction(tx.id, { category: 'Dining' });
      await store.correctTransaction(tx.id, { category: 'Dining' });
      await store.correctTransaction(tx.id, { category: 'Groceries' });
      await store.correctTransaction(tx.id, { category: 'Groceries' });
      const rows = await events();
      assert.deepEqual(
        rows.map((r) => r.payload.state),
        ['opened', 'resolved', 'reopened']
      );
      assert.deepEqual(
        rows.map((r) => r.revision),
        [1, 2, 3]
      );
      assert.equal(new Set(rows.map((r) => r.alert_id)).size, 1);
      assert.equal(rows[1].payload.amountMinor, '600');
      assert.deepEqual(Object.keys(rows[0].payload).sort(), ['amountMinor', 'category', 'currency', 'month', 'state']);
      await assert.rejects(
        store.atomic(async (c) => {
          await c.query('DELETE FROM budgets WHERE mode=$1', ['live']);
          await store.refreshAlerts(c);
          throw Error('rollback probe');
        })
      );
      assert.equal((await events()).length, 3);
      assert.equal((await pool.query('SELECT resolved_at FROM budget_alerts')).rows[0].resolved_at, null);
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  }
);
