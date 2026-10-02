import test from 'node:test';
import assert from 'node:assert/strict';
import { invokeFinanceTool, FINANCE_TOOLS } from '../src/lib/assistant-tools.mjs';
const ids = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444'
];
const rows = [
  {
    id: ids[0],
    accountId: 'allowed',
    currency: 'AUD',
    description: 'Coffee',
    date: '2026-09-10',
    amountMinor: '-1001',
    kind: 'expense',
    status: 'posted',
    category: 'Dining',
    splits: [
      { category: 'Dining', amountMinor: '-501' },
      { category: 'Work', amountMinor: '-500' }
    ]
  },
  {
    id: ids[1],
    accountId: 'allowed',
    currency: 'AUD',
    description: 'Refund',
    date: '2026-09-11',
    amountMinor: '201',
    kind: 'refund',
    status: 'posted',
    category: 'Dining',
    splits: []
  },
  {
    id: ids[2],
    accountId: 'allowed',
    currency: 'AUD',
    description: 'Internal transfer',
    date: '2026-09-12',
    amountMinor: '-9007199254740993',
    kind: 'transfer',
    status: 'posted',
    category: 'Transfers',
    splits: []
  },
  {
    id: ids[3],
    accountId: 'allowed',
    currency: 'AUD',
    description: 'Pending coffee',
    date: '2026-09-13',
    amountMinor: '-101',
    kind: 'expense',
    status: 'pending',
    category: 'Dining',
    splits: []
  },
  {
    id: '55555555-5555-4555-8555-555555555555',
    accountId: 'allowed',
    currency: 'AUD',
    description: 'Salary',
    date: '2026-08-20',
    amountMinor: '9007199254740993',
    kind: 'income',
    status: 'posted',
    category: 'Income',
    splits: []
  }
];
let allowed = true,
  calls = 0;
const selected = (f) =>
  allowed
    ? rows.filter(
        (t) =>
          t.currency === f.currency &&
          t.date >= f.from &&
          t.date <= f.to &&
          (!f.category || t.category === f.category || t.splits.some((s) => s.category === f.category)) &&
          (!f.search || t.description.toLowerCase().includes(f.search.toLowerCase()))
      )
    : [];
const finance = {
  listAccounts: async () =>
    allowed
      ? [
          {
            id: 'allowed',
            currency: 'AUD',
            balanceMinor: '9007199254740993',
            fetchedAt: '2026-09-30',
            reconciled: false
          }
        ]
      : [],
  transactionPage: async (f) => ({ total: selected(f).length }),
  exportSnapshot: async (f) => ({ transactions: selected(f) }),
  getTransaction: async (id) => {
    const t = allowed && rows.find((t) => t.id === id);
    if (!t) {
      throw Object.assign(Error('Not found'), { status: 404 });
    }

    return t;
  },
  report: async () => ({
    budgets: [
      {
        id: ids[0],
        category: 'Dining',
        spentMinor: '800',
        transactionIds: ['MUST-REMOVE']
      }
    ],
    alerts: [{ category: 'Dining', amountMinor: '1' }]
  })
};
const options = {
  getFinance: async () => {
    calls++;
    return finance;
  },
  now: () => new Date('2026-09-30T01:00:00Z')
};
const base = {
  currency: 'AUD',
  from: '2026-09-01',
  to: '2026-09-30',
  accountId: null,
  merchant: null,
  category: null,
  minAmountMinor: null,
  maxAmountMinor: null,
  status: null,
  kind: null
};
const aggregate = {
  ...base,
  groupBy: 'category',
  sortBy: 'expenses',
  direction: 'desc',
  limit: 100,
  comparePrevious: false
};
test('finance tool schemas are strict and all optional values explicit nullable; model cannot choose actor, SQL or unbounded filters', async () => {
  for (const t of FINANCE_TOOLS) {
    assert.equal(t.parameters.additionalProperties, false);
    assert.deepEqual(t.parameters.required, Object.keys(t.parameters.properties));
  }

  await assert.rejects(() => invokeFinanceTool('sql', { query: 'SELECT *' }, options), /Unknown/);
  await assert.rejects(() => invokeFinanceTool('finance_accounts', { currency: 'AUD', actorId: 'admin' }, options));
  await assert.rejects(
    () => invokeFinanceTool('finance_aggregate', { ...aggregate, from: '2025-01-01' }, options),
    /366/
  );
  await assert.rejects(
    () => invokeFinanceTool('finance_aggregate', { ...aggregate, from: '2026-02-30' }, options),
    /calendar/
  );
  await assert.rejects(() => invokeFinanceTool('finance_transactions', { ...base, page: 1, pageSize: 101 }, options));
});
test('exact finance aggregate uses complete authorized snapshot, split category projection, refunds, pending and transfer semantics', async () => {
  const all = await invokeFinanceTool('finance_aggregate', aggregate, options);
  assert.equal(all.data.totals.expensesMinor, '800');
  assert.equal(all.data.totals.pendingMinor, '-101');
  assert.equal(all.data.totals.transfersMinor, '-9007199254740993');
  assert.equal(all.data.totals.transactionCount, 4);
  const dining = await invokeFinanceTool('finance_aggregate', { ...aggregate, category: 'Dining' }, options);
  assert.equal(dining.data.totals.expensesMinor, '300');
  assert.equal(all.provenance.currency, 'AUD');
  assert.equal(all.provenance.timeZone, 'Australia/Brisbane');
  assert.equal(all.provenance.truncated, false);
  const compare = await invokeFinanceTool('finance_aggregate', { ...aggregate, comparePrevious: true }, options);
  assert.equal(compare.data.comparison.totals.incomeMinor, '9007199254740993');
  assert.equal(compare.data.comparison.delta.incomeMinor, '-9007199254740993');
});
test('pagination is explicit, signed amounts are exact, default90d, reports retain query not privileges, and detail budget data stays bounded', async () => {
  const tx = await invokeFinanceTool('finance_transactions', { ...base, page: 1, pageSize: 1 }, options);
  assert.equal(tx.data.total, 4);
  assert.equal(tx.data.transactions.length, 1);
  assert.equal(tx.provenance.truncated, true);
  const amount = await invokeFinanceTool(
    'finance_transactions',
    {
      ...base,
      minAmountMinor: '-102',
      maxAmountMinor: '-100',
      page: 1,
      pageSize: 100
    },
    options
  );
  assert.equal(amount.data.total, 1);
  const defaultRange = await invokeFinanceTool('finance_aggregate', { ...aggregate, from: null, to: null }, options);
  assert.equal(defaultRange.provenance.filters.from, '2026-07-03');
  const report = await invokeFinanceTool('finance_report', { ...aggregate, title: 'Monthly report' }, options);
  assert.equal(report.reportQuery.tool, 'finance_report');
  assert.equal(report.reportQuery.args.from, '2026-09-01');
  assert(!('actorId' in report.reportQuery.args));
  const budget = await invokeFinanceTool(
    'finance_budgets',
    { currency: 'AUD', month: '2026-09', budgetId: null },
    options
  );
  assert.deepEqual(budget.data.budgets[0].transactionIds, []);
  assert(!JSON.stringify(budget).includes('MUST-REMOVE'));
  const detail = await invokeFinanceTool('finance_transaction', { currency: 'AUD', transactionId: ids[0] }, options);
  assert.equal(detail.data.transaction.splits.length, 2);
  await assert.rejects(
    () => invokeFinanceTool('finance_transaction', { currency: 'USD', transactionId: ids[0] }, options),
    { status: 404 }
  );
});
test('fresh authorization is retrieved per invocation and overlarge selection/output fails rather than partial totals', async () => {
  const prior = calls;
  allowed = false;
  try {
    const r = await invokeFinanceTool('finance_aggregate', aggregate, options);
    assert.equal(r.data.totals.transactionCount, 0);
    await assert.rejects(
      () => invokeFinanceTool('finance_transaction', { currency: 'AUD', transactionId: ids[0] }, options),
      { status: 404 }
    );
    assert(calls >= prior + 2);
  } finally {
    allowed = true;
  }

  await assert.rejects(
    () =>
      invokeFinanceTool('finance_aggregate', aggregate, {
        ...options,
        getFinance: async () => ({
          ...finance,
          transactionPage: async () => ({ total: 10001 })
        })
      }),
    /No partial total/
  );
  await assert.rejects(
    () =>
      invokeFinanceTool(
        'finance_accounts',
        { currency: 'AUD' },
        {
          ...options,
          getFinance: async () => ({
            ...finance,
            listAccounts: async () => [
              {
                id: 'allowed',
                currency: 'AUD',
                description: 'x'.repeat(70000)
              }
            ]
          })
        }
      ),
    /64 KiB/
  );
});
