import { z } from 'zod';
import { calculateSelectionReport, minor } from './engine.js';
const MAX_ROWS = 10000;
const MAX_BYTES = 65536;
const DAY = 86400000;
const nullableText = z.string().trim().min(1).max(200).nullable();
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .nullable();
const amount = z
  .string()
  .regex(/^-?\d{1,18}$/)
  .nullable();
const common = {
  currency: z.string().regex(/^[A-Z]{3}$/),
  from: date,
  to: date,
  accountId: nullableText,
  merchant: nullableText,
  category: nullableText,
  minAmountMinor: amount,
  maxAmountMinor: amount,
  status: z.enum(['posted', 'pending']).nullable(),
  kind: z.enum(['expense', 'income', 'transfer', 'refund']).nullable()
};
const schema = {
  finance_accounts: z.object({ currency: common.currency }).strict(),
  finance_transactions: z
    .object({
      ...common,
      page: z.number().int().min(1).max(100),
      pageSize: z.number().int().min(1).max(100)
    })
    .strict(),
  finance_transaction: z.object({ transactionId: z.string().uuid(), currency: common.currency }).strict(),
  finance_aggregate: z
    .object({
      ...common,
      groupBy: z.enum(['none', 'month', 'category', 'merchant', 'account']),
      sortBy: z.enum(['key', 'expenses', 'income', 'net']),
      direction: z.enum(['asc', 'desc']),
      limit: z.number().int().min(1).max(100),
      comparePrevious: z.boolean()
    })
    .strict(),
  finance_budgets: z
    .object({
      currency: common.currency,
      month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
      budgetId: z.string().uuid().nullable()
    })
    .strict(),
  finance_quality: z.object({ currency: common.currency }).strict(),
  finance_report: z
    .object({
      ...common,
      groupBy: z.enum(['none', 'month', 'category', 'merchant', 'account']),
      sortBy: z.enum(['key', 'expenses', 'income', 'net']),
      direction: z.enum(['asc', 'desc']),
      limit: z.number().int().min(1).max(100),
      comparePrevious: z.boolean(),
      title: z.string().trim().min(1).max(120)
    })
    .strict()
};
const descriptions = {
  finance_accounts:
    'Read only permitted account balances, labels, source freshness and coverage. Bank balances are independent snapshots, never a proof of ledger reconciliation.',
  finance_transactions:
    'Search permitted transactions by bounded dates, signed minor-unit amount range, merchant substring, category, account, status or kind. Paginated details, at most 100 rows. Not an aggregate tool.',
  finance_transaction:
    'Read one permitted transaction and its exact splits, kind/refund status and correction note. Unknown or forbidden IDs have the same not-found response.',
  finance_aggregate:
    'Calculate exact income, spending, net, pending and transfer totals for the complete permitted selection. Group by month/category/merchant/account, rank groups, or compare with an equally long preceding date period. Transfers excluded from spending; posted refunds reduce spending. Never sum only a displayed page.',
  finance_budgets:
    'Read separately granted budget totals, caps, allocations, rollover and overspend alerts for one month. Budget grants authorize household category totals, never underlying transactions.',
  finance_quality:
    'Read permitted account coverage and freshness. Returns no credentials, provider payloads, hidden account identities or household-wide import status.',
  finance_report:
    'Prepare exact permitted aggregate report data and a validated report query for an explicitly requested download. This does not create a public link or broaden permissions; downloading must recheck current grants.'
};
const str = { type: 'string' };
const optionalString = (extra = {}) => ({ type: ['string', 'null'], ...extra });
const baseJson = {
  currency: { type: 'string', pattern: '^[A-Z]{3}$' },
  from: optionalString({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
  to: optionalString({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
  accountId: optionalString(),
  merchant: optionalString(),
  category: optionalString(),
  minAmountMinor: optionalString({ pattern: '^-?\\d{1,18}$' }),
  maxAmountMinor: optionalString({ pattern: '^-?\\d{1,18}$' }),
  status: { type: ['string', 'null'], enum: ['posted', 'pending', null] },
  kind: {
    type: ['string', 'null'],
    enum: ['expense', 'income', 'transfer', 'refund', null]
  }
};
const grouping = {
  groupBy: {
    type: 'string',
    enum: ['none', 'month', 'category', 'merchant', 'account']
  },
  sortBy: { type: 'string', enum: ['key', 'expenses', 'income', 'net'] },
  direction: { type: 'string', enum: ['asc', 'desc'] },
  limit: { type: 'integer', minimum: 1, maximum: 100 },
  comparePrevious: { type: 'boolean' }
};
const properties = {
  finance_accounts: { currency: baseJson.currency },
  finance_transactions: {
    ...baseJson,
    page: { type: 'integer', minimum: 1, maximum: 100 },
    pageSize: { type: 'integer', minimum: 1, maximum: 100 }
  },
  finance_transaction: { transactionId: str, currency: baseJson.currency },
  finance_aggregate: { ...baseJson, ...grouping },
  finance_budgets: {
    currency: baseJson.currency,
    month: str,
    budgetId: optionalString()
  },
  finance_quality: { currency: baseJson.currency },
  finance_report: {
    ...baseJson,
    ...grouping,
    title: { type: 'string', maxLength: 120 }
  }
};
export const FINANCE_TOOLS = Object.entries(properties).map(([name, props]) => ({
  type: 'function',
  name,
  description: descriptions[name],
  strict: true,
  parameters: {
    type: 'object',
    properties: props,
    required: Object.keys(props),
    additionalProperties: false
  }
}));
const fail = (message, status = 400) => {
  throw Object.assign(Error(message), { status, expose: true });
};
function isoDate(value) {
  if (!value || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) {
    fail('Invalid calendar date');
  }
  return value;
}
function selection(args, today) {
  const to = isoDate(args.to || today),
    from = isoDate(args.from || new Date(Date.parse(to) - 89 * DAY).toISOString().slice(0, 10));
  const duration = (Date.parse(to) - Date.parse(from)) / DAY + 1;
  if (duration < 1 || duration > 366) {
    fail('Choose a date range of 1 to 366 days');
  }
  if (
    args.minAmountMinor != null &&
    args.maxAmountMinor != null &&
    minor(args.minAmountMinor) > minor(args.maxAmountMinor)
  ) {
    fail('Amount range is reversed');
  }
  return {
    currency: args.currency,
    from,
    to,
    ...Object.fromEntries(
      ['accountId', 'category', 'status', 'kind'].filter((k) => args[k] != null).map((k) => [k, args[k]])
    ),
    ...(args.merchant ? { search: args.merchant } : {})
  };
}
const safeTransaction = (t) =>
  Object.fromEntries(
    [
      'id',
      'accountId',
      'accountName',
      'currency',
      'amountMinor',
      'date',
      'description',
      'status',
      'kind',
      'category',
      'splits',
      'reviewRequired',
      'fetchedAt'
    ].map((k) => [k, t[k]])
  );
const stats = (rows) => ({
  transactionCount: rows.length,
  postedCount: rows.filter((t) => t.status === 'posted').length,
  pendingCount: rows.filter((t) => t.status === 'pending').length,
  refundCount: rows.filter((t) => t.kind === 'refund' && t.status === 'posted').length
});
function totals(rows, currency) {
  const r = calculateSelectionReport(rows, { currency });
  return {
    ...stats(rows),
    ...Object.fromEntries(
      ['incomeMinor', 'expensesMinor', 'netMinor', 'pendingMinor', 'transfersMinor'].map((k) => [k, r[k]])
    )
  };
}
async function snapshot(finance, filters, args) {
  const page = await finance.transactionPage({
    ...filters,
    page: 1,
    pageSize: 1
  });
  if (page.total > MAX_ROWS) {
    fail('Selection exceeds 10000 transactions; narrow the dates or filters. No partial total was calculated.', 422);
  }
  const data = await finance.exportSnapshot(filters);
  if (data.transactions.length > MAX_ROWS) {
    fail('Selection exceeds 10000 transactions; narrow the dates or filters. No partial total was calculated.', 422);
  }
  return data.transactions.filter(
    (t) =>
      (args.minAmountMinor == null || minor(t.amountMinor) >= minor(args.minAmountMinor)) &&
      (args.maxAmountMinor == null || minor(t.amountMinor) <= minor(args.maxAmountMinor))
  );
}
function projected(rows, category) {
  return rows.map((t) => {
    if (!category || !t.splits?.length || t.kind === 'income' || t.kind === 'transfer') {
      return t;
    }
    const splits = t.splits.filter((s) => s.category === category);
    return {
      ...t,
      splits,
      amountMinor: String(splits.reduce((n, s) => n + minor(s.amountMinor), 0n))
    };
  });
}
function grouped(rows, args) {
  const map = new Map();
  const add = (key, t) => {
    if (!map.has(key)) {
      map.set(key, []);
    }
    map.get(key).push(t);
  };
  for (const t of rows) {
    if (args.groupBy === 'category' && t.splits?.length && t.kind !== 'income' && t.kind !== 'transfer') {
      const splitGroups = new Map();
      for (const s of t.splits) {
        splitGroups.set(s.category, [...(splitGroups.get(s.category) || []), s]);
      }
      for (const [category, splits] of splitGroups) {
        add(category, {
          ...t,
          category,
          splits,
          amountMinor: String(splits.reduce((n, s) => n + minor(s.amountMinor), 0n))
        });
      }
    } else {
      add(
        args.groupBy === 'month'
          ? t.date.slice(0, 7)
          : args.groupBy === 'category'
            ? t.category
            : args.groupBy === 'merchant'
              ? t.description
              : args.groupBy === 'account'
                ? t.accountId
                : 'all',
        t
      );
    }
  }
  const groups = [...map].map(([key, tx]) => ({
    key,
    ...totals(tx, args.currency)
  }));
  groups.sort((a, b) => {
    const n =
      args.sortBy === 'key'
        ? a.key.localeCompare(b.key)
        : BigInt(a[`${args.sortBy}Minor`]) < BigInt(b[`${args.sortBy}Minor`])
          ? -1
          : BigInt(a[`${args.sortBy}Minor`]) > BigInt(b[`${args.sortBy}Minor`])
            ? 1
            : a.key.localeCompare(b.key);
    return args.direction === 'desc' ? -n : n;
  });
  return {
    totals: totals(rows, args.currency),
    groups: groups.slice(0, args.limit),
    groupCount: groups.length,
    groupsTruncated: groups.length > args.limit
  };
}
/** Read-only bounded tools; identity and authorization are supplied exclusively by the server. */
export async function invokeFinanceTool(
  name,
  input,
  { getFinance, now = () => new Date(), timeZone = 'Australia/Brisbane' } = {}
) {
  if (!Object.hasOwn(schema, name)) {
    fail('Unknown finance tool');
  }
  const args = schema[name].parse(input),
    clock = typeof now === 'function' ? now() : now,
    asOf = new Date(clock).toISOString();
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date(clock));
  const finance = await getFinance();
  const accounts = (await finance.listAccounts()).filter((a) => a.currency === args.currency);
  const coverage = accounts.map((a) => ({
    accountId: a.id,
    fetchedAt: a.fetchedAt,
    coverage: a.coverage,
    reconciled: a.reconciled === true,
    reason: a.reconciliationReason
  }));
  let data,
    filters = { currency: args.currency },
    truncated = false,
    reportQuery;
  if (name === 'finance_accounts') {
    data = { accounts };
  } else if (name === 'finance_quality') {
    data = {
      accounts: coverage,
      complete: false,
      reason: 'Imported coverage only. No bank freshness or arithmetic reconciliation guarantee.'
    };
  } else if (name === 'finance_transaction') {
    const t = await finance.getTransaction(args.transactionId);
    if (t.currency !== args.currency) {
      fail('Not found', 404);
    }
    data = {
      transaction: { ...safeTransaction(t), note: t.note || '' },
      reference: { type: 'transaction', id: t.id }
    };
    filters = { ...filters, transactionId: t.id };
  } else if (name === 'finance_budgets') {
    const report = await finance.report({
      month: args.month,
      currency: args.currency,
      months: 1
    });
    const budgets = report.budgets
      .filter((b) => !args.budgetId || b.id === args.budgetId)
      .map((b) => ({ ...b, transactionIds: [] }));
    if (args.budgetId && !budgets.length) {
      fail('Not found', 404);
    }
    data = {
      budgets,
      alerts: report.alerts.filter((a) => budgets.some((b) => b.category === a.category)),
      scope:
        'Only explicitly granted budgets. Budget totals include the whole household category; no underlying account or merchant access is granted.'
    };
    filters = { ...filters, month: args.month, budgetId: args.budgetId };
  } else {
    filters = selection(args, today);
    const rows = await snapshot(finance, filters, args);
    if (name === 'finance_transactions') {
      const start = (args.page - 1) * args.pageSize;
      data = {
        transactions: rows.slice(start, start + args.pageSize).map(safeTransaction),
        total: rows.length,
        page: args.page,
        pageSize: args.pageSize,
        totalPages: Math.ceil(rows.length / args.pageSize)
      };
      truncated = data.totalPages > args.page || args.page > 1;
    } else {
      data = grouped(projected(rows, args.category), args);
      truncated = data.groupsTruncated;
      if (args.comparePrevious) {
        const width = Date.parse(filters.to) - Date.parse(filters.from) + DAY;
        const previous = {
          ...filters,
          from: new Date(Date.parse(filters.from) - width).toISOString().slice(0, 10),
          to: new Date(Date.parse(filters.from) - DAY).toISOString().slice(0, 10)
        };
        const prev = totals(projected(await snapshot(finance, previous, args), args.category), args.currency);
        data.comparison = {
          filters: previous,
          totals: prev,
          delta: Object.fromEntries(
            ['incomeMinor', 'expensesMinor', 'netMinor', 'pendingMinor', 'transfersMinor'].map((k) => [
              k,
              String(BigInt(data.totals[k]) - BigInt(prev[k]))
            ])
          )
        };
      }
      if (name === 'finance_report') {
        reportQuery = {
          tool: 'finance_report',
          args: { ...args, from: filters.from, to: filters.to }
        };
        data.title = args.title;
      }
    }
  }
  const result = {
    data,
    provenance: {
      filters: {
        ...filters,
        ...Object.fromEntries(
          ['minAmountMinor', 'maxAmountMinor'].filter((k) => args[k] != null).map((k) => [k, args[k]])
        )
      },
      timeZone,
      currency: args.currency,
      asOf,
      coverage,
      truncated,
      scope: 'Current server-authorized records only',
      policies: {
        actuals: 'posted-only',
        refunds: 'Refunds reduce spending in their posted date period.',
        transfers: 'Internal transfers and repayments excluded from spending.',
        categoryFilter:
          'Aggregate category filters count only matching splits; transaction search returns the complete matching transaction.',
        amountFilter: 'Signed original transaction minor-unit amount, before category split projection.'
      }
    },
    ...(reportQuery ? { reportQuery } : {})
  };
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_BYTES) {
    fail('Tool result exceeds 64 KiB; narrow the query or page size. No partial total was returned.', 422);
  }
  return result;
}
