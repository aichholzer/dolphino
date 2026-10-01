import assert from 'node:assert/strict';
import test from 'node:test';
import { api } from '../src/lib/api.js';
import { reportPath, reportQuery, reportingMonth } from '../src/lib/report-query.js';
import { workspaceAccess, workspaceIdentity } from '../src/lib/workspace-access.js';
import {
  accountTransactionFilters,
  drilldownFilters,
  initialTransactionFilters,
  transactionCorrection
} from '../src/features/transactions/transaction-model.js';
import { budgetValues } from '../src/features/budgets/budget-model.js';

const member = (permissions = {}) => ({ authenticated: true, user: { id: 'member', role: 'member' }, permissions });
const query = (page, filters = {}, options = {}) =>
  new URLSearchParams(
    reportQuery({
      page,
      month: '2026-09',
      currency: 'AUD',
      period: 3,
      filters: { ...initialTransactionFilters(), ...filters },
      ...options
    })
  );

test('workspace access keeps account and budget grants separate', () => {
  const account = workspaceAccess(member({ accounts: [{ accountId: 'one', access: 'view' }] }));
  assert.equal(account.hasFinancialAccess, true);
  for (const page of ['Overview', 'Accounts', 'Transactions']) {
    assert.equal(account.canNavigate(page), true);
  }
  for (const page of ['Budgets', 'Review', 'Rules', 'Settings']) {
    assert.ok(!account.canNavigate(page));
  }
  assert.equal(account.canEditAccount('one'), false);
  const budget = workspaceAccess(member({ budgets: [{ budgetId: 'cap', access: 'edit' }] }));
  assert.equal(budget.canNavigate('Budgets'), true);
  assert.equal(budget.canNavigate('Transactions'), false);
  assert.ok(!budget.canNavigate('Review'));
  assert.equal(workspaceAccess(member()).hasFinancialAccess, false);
  assert.equal(workspaceAccess(null).hasFinancialAccess, false);
});

test('account editors get review access only for editable account grants', () => {
  const access = workspaceAccess(
    member({
      accounts: [
        { accountId: 'edit', access: 'edit' },
        { accountId: 'view', access: 'view' }
      ]
    })
  );
  assert.equal(access.canNavigate('Review'), true);
  assert.equal(access.canEditAccount('edit'), true);
  assert.equal(access.canEditAccount('view'), false);
  assert.equal(access.canEditAccount('unknown'), false);
});

test('administrators and fictional demo retain every existing workspace capability', () => {
  for (const session of [{ user: { role: 'admin' } }, { demo: true }]) {
    const access = workspaceAccess(session);
    assert.equal(access.isAdmin, true);
    assert.equal(access.canEditAccount('any'), true);
    for (const page of ['Overview', 'Transactions', 'Accounts', 'Budgets', 'Review', 'Rules', 'Settings']) {
      assert.equal(access.canNavigate(page), true);
    }
  }
});

test('workspace identity invalidates cached state for principal, role, grants and access revision changes', () => {
  const base = member({ accessRevision: '1', accounts: [{ accountId: 'one', access: 'edit' }] });
  const identity = workspaceIdentity(base);
  assert.equal(workspaceIdentity(structuredClone(base)), identity);
  assert.notEqual(workspaceIdentity({ ...base, user: { ...base.user, id: 'other' } }), identity);
  assert.notEqual(workspaceIdentity({ ...base, user: { ...base.user, role: 'admin' } }), identity);
  assert.notEqual(workspaceIdentity({ ...base, permissions: { ...base.permissions, accessRevision: '2' } }), identity);
  assert.notEqual(workspaceIdentity({ ...base, permissions: { ...base.permissions, accounts: [] } }), identity);
  assert.notEqual(workspaceIdentity({ demo: true }), identity);
});

test('reporting month follows the configured timezone at month boundaries', () => {
  const now = new Date('2026-09-30T15:00:00Z');
  assert.equal(reportingMonth({ timeZone: 'Australia/Brisbane' }, now), '2026-10');
  assert.equal(reportingMonth({ timeZone: 'America/Los_Angeles' }, now), '2026-09');
  assert.equal(reportingMonth(null, now), '2026-09');
});

test('overview and month-scoped transactions preserve report and pagination parameters', () => {
  assert.deepEqual(Object.fromEntries(query('Overview')), { month: '2026-09', currency: 'AUD', months: '3' });
  assert.deepEqual(Object.fromEntries(query('Transactions')), {
    month: '2026-09',
    currency: 'AUD',
    page: '1',
    pageSize: '50'
  });
});

test('transaction history, custom dates, and exact ID scopes omit month only on Transactions', () => {
  for (const filters of [
    { allHistory: true },
    { from: '2026-08-02' },
    { to: '2026-09-12' },
    { ids: [] },
    { ids: ['a'] }
  ]) {
    assert.equal(query('Transactions', filters).has('month'), false);
    assert.equal(query('Overview', filters).get('month'), '2026-09');
  }
  assert.equal(query('Transactions', { ids: [] }).get('ids'), '');
  assert.equal(query('Transactions', { ids: null }).has('ids'), false);
});

test('transaction search, account, currency, exact IDs and filters survive URL encoding', () => {
  const filters = {
    search: 'Coffee & tea + 2',
    accountId: 'bank/a & b',
    category: 'Home & garden',
    status: 'posted',
    kind: 'refund',
    ids: ['one', 'two'],
    txPage: 4,
    allHistory: true,
    from: '2026-01-01',
    to: '2026-09-30'
  };
  const result = query('Transactions', filters, { currency: 'JPY' });
  assert.equal(result.get('search'), filters.search);
  assert.equal(result.get('accountId'), filters.accountId);
  assert.equal(result.get('category'), filters.category);
  assert.equal(result.get('status'), filters.status);
  assert.equal(result.get('kind'), filters.kind);
  assert.equal(result.get('ids'), 'one,two');
  assert.equal(result.get('page'), '4');
  assert.equal(result.get('allHistory'), 'true');
  assert.equal(result.get('from'), filters.from);
  assert.equal(result.get('to'), filters.to);
  assert.equal(result.get('currency'), 'JPY');
});

test('page resource paths match the existing API contract', () => {
  assert.deepEqual(
    ['Overview', 'Transactions', 'Accounts', 'Budgets', 'Review', 'Rules', 'Settings'].map((page) =>
      reportPath(page, 'scope=test')
    ),
    [
      '/dashboard?scope=test',
      '/transactions?scope=test',
      '/accounts',
      '/budgets?scope=test',
      '/reviews',
      '/rules',
      '/settings'
    ]
  );
});

test('overview drilldowns carry multi-month date coverage unless explicitly scoped', () => {
  const context = { page: 'Overview', startDate: '2026-07-01', endDate: '2026-09-30' };
  const generic = drilldownFilters({ category: 'Dining' }, context);
  assert.equal(generic.from, context.startDate);
  assert.equal(generic.to, context.endDate);
  assert.equal(generic.category, 'Dining');
  assert.equal(generic.status, 'posted');
  assert.equal(generic.txPage, 1);
  for (const selection of [{ month: '2026-08' }, { ids: [] }, { ids: ['one'] }]) {
    const filters = drilldownFilters(selection, context);
    assert.equal(filters.from, '');
    assert.equal(filters.to, '');
  }
  assert.equal(drilldownFilters({ status: '' }, context).status, '');
  assert.equal(drilldownFilters({ status: 'pending' }, context).status, 'pending');
  assert.equal(drilldownFilters({}, { ...context, page: 'Budgets' }).from, '');
});

test('opening account history starts a clean account scope', () => {
  assert.deepEqual(accountTransactionFilters({ id: 'bank', name: 'Everyday' }), {
    ...initialTransactionFilters(),
    accountId: 'bank',
    accountName: 'Everyday',
    allHistory: true
  });
  const first = initialTransactionFilters();
  first.search = 'changed';
  assert.equal(initialTransactionFilters().search, '');
});

test('transaction correction preserves exact signed amounts above Number precision', () => {
  const values = transactionCorrection(
    {
      category: 'Split',
      kind: 'expense',
      splits: [
        { category: 'Housing', amount: '-9007199254740993.01' },
        { category: 'Other', amount: '-0.99' }
      ]
    },
    { amountMinor: '-900719925474099400', currency: 'AUD' }
  );
  assert.deepEqual(values, {
    category: 'Split',
    kind: 'expense',
    splits: [
      { category: 'Housing', amountMinor: '-900719925474099301' },
      { category: 'Other', amountMinor: '-99' }
    ]
  });
});

test('transaction correction rejects a one-minor-unit mismatch and wrong sign', () => {
  for (const amount of ['-6.49', '6.50']) {
    assert.throws(
      () =>
        transactionCorrection(
          { category: 'Dining', kind: 'expense', splits: [{ category: 'Dining', amount }] },
          { amountMinor: '-650', currency: 'AUD' }
        ),
      /Split amounts must add up exactly/
    );
  }
  assert.deepEqual(
    transactionCorrection(
      { category: 'Dining', kind: 'expense', splits: [] },
      { amountMinor: '-650', currency: 'AUD' }
    ),
    { category: 'Dining', kind: 'expense', splits: [] }
  );
});

test('transaction split precision follows the source currency', () => {
  assert.equal(
    transactionCorrection(
      { category: 'Other', kind: 'refund', splits: [{ category: 'Other', amount: '17' }] },
      { amountMinor: '17', currency: 'JPY' }
    ).splits[0].amountMinor,
    '17'
  );
  assert.equal(
    transactionCorrection(
      { category: 'Other', kind: 'refund', splits: [{ category: 'Other', amount: '1.001' }] },
      { amountMinor: '1001', currency: 'KWD' }
    ).splits[0].amountMinor,
    '1001'
  );
  assert.throws(
    () =>
      transactionCorrection(
        { splits: [{ category: 'Other', amount: '17.01' }] },
        { amountMinor: '17', currency: 'JPY' }
      ),
    /no decimal places/
  );
});

test('budget payloads preserve exact caps, allocations, zero and rollover opt-in', () => {
  assert.deepEqual(
    budgetValues({ category: 'Housing', cap: '9007199254740993.01', allocation: '0.99', rollover: true }, 'AUD'),
    { category: 'Housing', capMinor: '900719925474099301', allocationMinor: '99', rolloverEnabled: true }
  );
  assert.deepEqual(budgetValues({ category: 'Other', cap: '0', allocation: '0', rollover: false }, 'JPY'), {
    category: 'Other',
    capMinor: '0',
    allocationMinor: '0',
    rolloverEnabled: false
  });
  assert.throws(() => budgetValues({ cap: '-0.01', allocation: '0' }, 'AUD'), /A cap must be positive/);
  assert.throws(() => budgetValues({ cap: '1', allocation: '-0.01' }, 'AUD'), /An allocation cannot be negative/);
  assert.throws(() => budgetValues({ cap: '1.001', allocation: '0' }, 'AUD'), /up to 2 decimal places/);
});

test('API client keeps same-origin credentials, JSON headers and structured error precedence', async (t) => {
  let received;
  t.mock.method(globalThis, 'fetch', async (...args) => {
    received = args;
    return { ok: true, json: async () => ({ ok: true }) };
  });
  assert.deepEqual(await api('/transactions', { method: 'PATCH', headers: { 'X-Test': 'yes' }, body: '{}' }), {
    ok: true
  });
  assert.deepEqual(received, [
    '/api/transactions',
    {
      credentials: 'same-origin',
      method: 'PATCH',
      body: '{}',
      headers: { 'Content-Type': 'application/json', 'X-Test': 'yes' }
    }
  ]);
  for (const [data, message] of [
    [{ error: { message: 'Structured error' } }, 'Structured error'],
    [{ error: 'String error' }, 'String error'],
    [{ message: 'Fallback message' }, 'Fallback message'],
    [{}, 'Request failed (503)']
  ]) {
    globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => data });
    await assert.rejects(api('/accounts'), { message });
  }
  globalThis.fetch = async () => ({
    ok: false,
    status: 502,
    json: async () => {
      throw new SyntaxError('bad JSON');
    }
  });
  await assert.rejects(api('/accounts'), { message: 'Request failed (502)' });
});

test('transaction editor omits untouched category, kind and splits without copying provider defaults', () => {
  const transaction = {
    category: 'cat_Legacy',
    categoryDisplayLabel: 'Unresolved category',
    kind: 'expense',
    amountMinor: '-1234',
    currency: 'AUD',
    splits: [{ category: 'cat_Split', amountMinor: '-1234', categoryDisplayLabel: 'Unresolved category' }]
  };
  const input = {
    category: 'cat_Legacy',
    categoryEdited: false,
    preserveUntouched: true,
    kind: 'expense',
    splits: [{ category: 'cat_Split', amount: '-12.34', categoryDisplayLabel: 'Unresolved category' }]
  };
  assert.deepEqual(transactionCorrection(input, transaction), {});
  assert.deepEqual(transactionCorrection({ ...input, kind: 'refund' }, transaction), { kind: 'refund' });
  assert.deepEqual(transactionCorrection({ ...input, categoryEdited: true, category: 'Groceries' }, transaction), {
    category: 'Groceries'
  });
  assert.deepEqual(
    transactionCorrection({ ...input, splits: [{ category: 'Dining', amount: '-12.34' }] }, transaction),
    {
      splits: [{ category: 'Dining', amountMinor: '-1234' }]
    }
  );
});
