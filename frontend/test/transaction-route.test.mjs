import test from 'node:test';
import assert from 'node:assert/strict';
import { readTransactionRoute, writeTransactionRoute } from '../src/lib/transaction-route.mjs';
import { workspaceRoute, workspaceHash } from '../src/features/settings/settings-navigation.mjs';
import { initialTransactionFilters } from '../src/features/transactions/transaction-model.mjs';
import { reportQuery } from '../src/lib/report-query.mjs';
import { ruleFromTransaction, ruleValues } from '../src/features/rules/rule-model.mjs';

const defaults = { month: '2026-09', currency: 'AUD' };
test('transaction URL roundtrip restores criteria and exact scopes without serializing data or permissions', () => {
  const filters = {
    ...initialTransactionFilters(),
    search: 'Café 100%_\\ & + ? #',
    accountId: 'account/one',
    category: 'Home & garden',
    tag: 'work',
    status: 'posted',
    kind: 'expense',
    from: '2026-01-01',
    to: '2026-09-30',
    txPage: 3
  };
  const query = writeTransactionRoute(filters, defaults);
  const route = workspaceRoute(workspaceHash({ page: 'Transactions', transactionQuery: query }));
  assert.deepEqual(readTransactionRoute(route.transactionQuery, defaults), { filters, ...defaults });
  assert.ok(!query.includes('accountName'));
  for (const ids of [[], ['b4f25d83-d5a8-49d0-9c67-a1b1c30651ac']]) {
    const encoded = writeTransactionRoute({ ...initialTransactionFilters(), ids }, defaults);
    assert.ok(!encoded.includes('month='));
    assert.deepEqual(readTransactionRoute(encoded, defaults).filters.ids, ids);
  }
});
test('malformed URL inputs stay bounded and invalid exact selections do not broaden results', () => {
  const result = readTransactionRoute(
    new URLSearchParams({
      ids: 'invalid',
      page: '-1',
      currency: 'secret',
      month: '2026-99',
      status: 'unknown',
      kind: 'unknown',
      search: 'x'.repeat(300)
    }).toString(),
    defaults
  );
  assert.deepEqual(result.filters.ids, []);
  assert.equal(result.filters.txPage, 1);
  assert.equal(result.filters.search.length, 200);
  assert.equal(result.filters.status, '');
  assert.equal(result.filters.kind, '');
  assert.equal(result.month, defaults.month);
  assert.equal(result.currency, defaults.currency);
});
test('transaction criteria never bleed into overview or budgets', () => {
  for (const page of ['Overview', 'Budgets']) {
    const params = new URLSearchParams(
      reportQuery({
        ...defaults,
        page,
        period: 1,
        filters: {
          ...initialTransactionFilters(),
          search: 'merchant',
          category: 'Travel',
          tag: 'work',
          ids: [],
          kind: 'expense',
          status: 'pending'
        }
      })
    );
    for (const key of ['search', 'category', 'tag', 'ids', 'kind', 'status']) {
      assert.equal(params.has(key), false);
    }
  }
});
test('transaction rule prefill uses the literal description and saved key, without guessing broad matches or copying money/evidence', () => {
  const tx = {
    id: 'tx',
    description: 'Train 100%_\\ to conference',
    category: 'Travel',
    categoryDisplayLabel: 'Journeys',
    kind: 'expense',
    tags: ['work'],
    amountMinor: '-12345',
    raw: { secret: 'never copied' }
  };
  const draft = ruleFromTransaction(tx);
  assert.equal(draft.match, tx.description);
  assert.equal(draft.category, 'Travel');
  assert.deepEqual(ruleValues(draft), {
    match: tx.description,
    category: 'Travel',
    kind: 'expense',
    tags: ['work'],
    priority: 0
  });
  assert.equal('amountMinor' in draft, false);
  draft.tags.push('new');
  assert.deepEqual(tx.tags, ['work']);
});

test('existing rules without a type retain imported classification instead of becoming expenses', () => {
  assert.equal(ruleValues({ id: 'existing', kind: null }).kind, undefined);
});

test('long source descriptions require an explicit match instead of silently broadening to a prefix', () => {
  assert.equal(ruleFromTransaction({ description: 'x'.repeat(201) }).match, '');
});
