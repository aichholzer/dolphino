import { readTestPostgresConfig } from './helpers/postgres.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { Store } from '../src/lib/store.mjs';
import { createAccessStore, validateAndSetGrants } from '../src/lib/access.mjs';
const database = readTestPostgresConfig();
test(
  'member scopes resist injected account lists and transfer overrides, revoke without cached grants, and report on a single connection',
  { skip: !database, timeout: 10000 },
  async () => {
    const admin = new pg.Pool(database);
    const schema = `access_security_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      ...database,
      options: `-c search_path=${schema}`,
      max: 1,
      connectionTimeoutMillis: 1000
    });
    try {
      const store = new Store(pool, { mode: 'live' });
      await store.migrate();
      const base = {
        currency: 'AUD',
        date: '2026-09-10',
        amountMinor: '-100',
        status: 'posted',
        kind: 'expense',
        category: 'Groceries'
      };
      const owned = await store.ingest({
        ...base,
        sourceId: 'owned',
        accountId: 'owned',
        description: 'Visible purchase'
      });
      const secret = await store.ingest({
        ...base,
        sourceId: 'hidden',
        accountId: 'hidden',
        description: 'Hidden private purchase'
      });
      const transfer = await store.ingest({
        ...base,
        sourceId: 'transfer',
        accountId: 'owned',
        kind: 'transfer',
        description: 'Hidden private account transfer',
        category: 'cat_Transfer',
        raw: { category: 'cat_Transfer' }
      });
      assert.equal((await store.getTransaction(transfer.id)).categoryDisplayLabel, 'Unresolved category');
      // An administrator's historical override cannot remove source-transfer sensitivity.
      await store.correctTransaction(transfer.id, {
        kind: 'expense',
        note: 'Hidden private note'
      });
      const member = { id: randomUUID(), role: 'member' };
      await store.atomic(
        (c) =>
          validateAndSetGrants(c, member.id, { accounts: [{ accountId: 'owned', access: 'edit' }] }, { mode: 'live' }),
        { refresh: false }
      );
      const scoped = await createAccessStore(store, member);
      const rows = await scoped.listTransactions({
        accountIds: ['hidden'],
        redactTransfers: false
      });
      assert.equal(rows.find((row) => row.id === transfer.id).categoryDisplayLabel, undefined);
      assert.equal(rows.find((row) => row.id === transfer.id).category, 'Transfers');
      assert(rows.every((row) => row.accountId === 'owned'));
      assert(!JSON.stringify(rows).includes('Hidden'));
      assert.deepEqual(await scoped.audit(transfer.id), []);
      assert.equal((await scoped.transactionPage({ search: 'Hidden', allHistory: true })).total, 0);
      await assert.rejects(scoped.correctTransaction(transfer.id, { kind: 'income' }), /administrator/);
      await assert.rejects(
        scoped.resolveReview(owned.id, {
          action: 'link',
          pendingId: secret.id
        }),
        (e) => e.status === 404
      );
      const report = await scoped.report({
        month: '2026-09',
        currency: 'AUD',
        months: 2
      });
      assert(report.transactionIds.expenses.every((id) => id !== secret.id));
      const exported = await scoped.exportSnapshot({
        month: '2026-09',
        currency: 'AUD',
        months: 2,
        accountIds: ['hidden']
      });
      assert(!JSON.stringify(exported.transactions).includes('Hidden'));
      await store.atomic((c) => validateAndSetGrants(c, member.id, { accounts: [] }, { mode: 'live' }), {
        refresh: false
      });
      assert.deepEqual(await scoped.listTransactions(), []);
      await assert.rejects(scoped.correctTransaction(owned.id, { category: 'Groceries' }), (e) => e.status === 404);
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  }
);
