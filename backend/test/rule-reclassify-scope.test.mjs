import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { guardPool } from '../src/lib/db.mjs';
import { Store } from '../src/lib/store.mjs';
import { readTestPostgresConfig } from './helpers/postgres.mjs';

const database = readTestPostgresConfig();

test('a rule change revisits only transactions matching its old or new text', { skip: !database }, async () => {
  const schema = `rule_scope_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ ...database });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = guardPool(new pg.Pool({ ...database, options: `-c search_path=${schema}` }), () => {});
  try {
    const store = new Store(pool, { mode: 'live', timezone: 'Etc/UTC' });
    await store.migrate();
    const base = {
      accountId: 'visible',
      accountName: 'Everyday',
      currency: 'AUD',
      status: 'posted',
      date: '2026-09-12',
      fetchedAt: '2026-09-14T00:00:00Z',
      category: 'Groceries'
    };
    const coffee = await store.ingest({
      ...base,
      sourceId: 'coffee',
      description: 'Corner COFFEE',
      amountMinor: '-500',
      kind: 'expense'
    });
    const refund = await store.ingest({
      ...base,
      sourceId: 'refund',
      description: 'Coffee refund',
      amountMinor: '300',
      kind: 'refund'
    });
    const books = await store.ingest({
      ...base,
      sourceId: 'books',
      description: 'Book store',
      amountMinor: '-900',
      kind: 'expense'
    });
    await store.ingest({
      ...base,
      sourceId: 'train',
      description: 'Train ticket',
      amountMinor: '-700',
      kind: 'expense',
      category: 'Travel'
    });
    // A row the rule never matches must not be rewritten.
    await pool.query("UPDATE transactions SET classification_category='Sentinel' WHERE id=$1", [books.id]);
    const state = async (id) =>
      (await pool.query('SELECT classification_category AS category, kind FROM transactions WHERE id=$1', [id]))
        .rows[0];

    const rule = await store.saveRule({ match: 'coffee', category: 'Travel' });
    assert.deepEqual(await state(coffee.id), { category: 'Travel', kind: 'expense' });
    assert.deepEqual(
      await state(refund.id),
      { category: 'Travel', kind: 'refund' },
      'provider kind survives a rule without a kind'
    );
    assert.deepEqual(await state(books.id), { category: 'Sentinel', kind: 'expense' });

    await store.saveRule({ id: rule.id, match: 'tea', category: 'Travel' });
    assert.deepEqual(
      await state(coffee.id),
      { category: 'Groceries', kind: 'expense' },
      'rows matching only the old text revert'
    );
    assert.deepEqual(await state(refund.id), { category: 'Groceries', kind: 'refund' });

    await store.saveRule({ id: rule.id, match: 'coffee', category: 'Travel', kind: 'transfer' });
    assert.deepEqual(await state(refund.id), { category: 'Travel', kind: 'transfer' });
    await store.deleteRule(rule.id);
    assert.deepEqual(
      await state(refund.id),
      { category: 'Groceries', kind: 'refund' },
      'deleting the rule restores the provider values'
    );
    assert.deepEqual(await state(books.id), { category: 'Sentinel', kind: 'expense' });
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
