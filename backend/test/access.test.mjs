import { readTestPostgresConfig } from './helpers/postgres.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/lib/store.mjs';
import { createAccessStore, validateAndSetGrants, validateGrants } from '../src/lib/access.mjs';
const database = readTestPostgresConfig();
test(
  'granular ledger and separate budget totals deny by default, preserve transfer privacy, revoke promptly, and work with one connection',
  { skip: !database },
  async () => {
    const admin = new pg.Pool(database);
    const schema = 'access_' + randomUUID().replaceAll('-', '');
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      ...database,
      max: 1,
      options: `-c search_path=${schema}`
    });
    const store = new Store(pool, { mode: 'live' });
    try {
      await store.migrate();
      const tx = async (accountId, sourceId, amountMinor, description, kind = 'expense', category = 'Dining') =>
        store.ingest({
          accountId,
          sourceId,
          amountMinor,
          description,
          kind,
          category,
          currency: 'AUD',
          status: 'posted',
          date: '2026-09-01',
          fetchedAt: '2026-09-02T00:00:00Z'
        });
      const a = await tx('a', 'a1', '-100', 'Public coffee');
      const b = await tx('b', 'b1', '-900', 'Private merchant', 'expense', 'Private category');
      const tr = await tx('a', 'a2', '-200', 'Transfer to hidden Kid Savings 123', 'transfer', 'Private transfer');
      await tx('b', 'b2', '200', 'Transfer from a', 'transfer');
      const budget = await store.saveBudget({
        category: 'Dining',
        month: '2026-09',
        currency: 'AUD',
        capMinor: '50',
        allocationMinor: '0'
      });
      const secretBudget = await store.saveBudget({
        category: 'Private category',
        month: '2026-09',
        currency: 'AUD',
        capMinor: '5'
      });
      await validateAndSetGrants(pool, 'viewer', {
        accounts: [{ accountId: 'a', access: 'view' }],
        budgets: []
      });
      await validateAndSetGrants(pool, 'editor', {
        accounts: [{ accountId: 'a', access: 'edit' }],
        budgets: []
      });
      await validateAndSetGrants(pool, 'budget', {
        accounts: [],
        budgets: [{ budgetId: budget.id, access: 'edit' }]
      });
      const view = await createAccessStore(store, {
          id: 'viewer',
          role: 'member'
        }),
        edit = await createAccessStore(store, { id: 'editor', role: 'member' }),
        budgetUser = await createAccessStore(store, {
          id: 'budget',
          role: 'member'
        }),
        none = await createAccessStore(store, { id: 'none', role: 'member' });
      assert.equal((await none.permissions()).financialAccess, false);
      assert.equal((await none.transactionPage({})).total, 0);
      assert.equal((await none.report({ month: '2026-09' })).expensesMinor, '0');
      const r = await view.report({
        month: '2026-09',
        months: 2,
        currency: 'AUD'
      });
      assert.equal(r.expensesMinor, '100');
      assert.equal(r.monthly.length, 2);
      assert.equal(r.budgets.length, 0);
      assert.equal(r.alerts.length, 0);
      assert.deepEqual(
        r.accounts.map((a) => a.id),
        ['a']
      );
      assert(!JSON.stringify(r).includes(b.id));
      const list = await view.transactionPage({
        allHistory: true,
        ids: [a.id, b.id]
      });
      assert.equal(list.total, 1);
      assert.equal(list.transactions[0].canEdit, false);
      assert.equal((await view.transactionPage({ search: 'hidden Kid' })).total, 0);
      assert.equal((await view.transactionPage({ category: 'Private transfer' })).total, 0);
      assert.equal((await view.transactionPage({ category: 'Transfers' })).total, 1);
      assert.equal((await view.getTransaction(tr.id)).description, 'Internal transfer');
      assert.equal((await view.audit(tr.id)).length, 0);
      await assert.rejects(() => view.getTransaction(b.id), { status: 404 });
      await assert.rejects(() => view.correctTransaction(a.id, { category: 'Other' }), { status: 404 });
      await assert.rejects(() => view.transactionPage({ accountId: 'b' }), {
        status: 404
      });
      await assert.rejects(() => edit.correctTransaction(tr.id, { kind: 'expense' }), /administrator/);
      assert.equal((await edit.correctTransaction(a.id, { note: 'My note' })).canEdit, true);
      const exp = await view.exportSnapshot({
        month: '2026-09',
        currency: 'AUD'
      });
      assert.equal(exp.summary.expensesMinor, '100');
      assert.equal(exp.transactions.length, 2);
      assert(!JSON.stringify(exp).includes('hidden Kid'));
      assert(!JSON.stringify(exp).includes('Private merchant'));
      const br = await budgetUser.report({ month: '2026-09', currency: 'AUD' });
      assert.equal(br.expensesMinor, '0');
      assert.equal(br.accounts.length, 0);
      assert.equal(br.budgets.length, 1);
      assert.equal(br.budgets[0].spentMinor, '100');
      assert.deepEqual(br.budgets[0].transactionIds, []);
      assert.equal(br.budgets[0].canDrill, false);
      assert.equal(br.alerts.length, 1);
      assert(!JSON.stringify(br).includes(a.id));
      await budgetUser.saveBudget({ ...budget, capMinor: '200' });
      await assert.rejects(() => budgetUser.saveBudget({ ...secretBudget, capMinor: '999' }), { status: 404 });
      await assert.rejects(() => budgetUser.correctTransaction(a.id, { note: 'bad' }), { status: 404 });
      await assert.rejects(() =>
        validateGrants(pool, {
          accounts: [{ accountId: 'a', access: 'admin' }],
          budgets: []
        })
      );
      await validateAndSetGrants(pool, 'viewer', { accounts: [], budgets: [] });
      assert.equal((await view.transactionPage({})).total, 0);
      await assert.rejects(() => view.getTransaction(a.id), { status: 404 });
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  }
);
