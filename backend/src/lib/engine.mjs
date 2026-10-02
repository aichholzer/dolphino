export function domainError(message) {
  const error = new Error(message);
  error.statusCode = message.includes('not found') ? 404 : 400;
  error.status = error.statusCode;
  return error;
}

/** Financial calculations use signed integer minor units only. Positive means money in. */
export const KINDS = ['expense', 'income', 'transfer', 'refund'];

export function minor(value) {
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) {
    throw domainError('amountMinor must be an integer string');
  }

  const result = BigInt(value);
  if (result < -9223372036854775808n || result > 9223372036854775807n) {
    throw domainError('amountMinor is outside supported range');
  }

  return result;
}

export function validateSplits(splits, amountMinor) {
  if (splits == null || (Array.isArray(splits) && splits.length === 0)) {
    return;
  }

  if (!Array.isArray(splits) || !splits.length || splits.length > 100) {
    throw domainError('Provide 1–100 splits');
  }

  let sum = 0n;
  for (const split of splits) {
    if (typeof split.category !== 'string' || !split.category.trim() || split.category.length > 100) {
      throw domainError('Split category is required');
    }

    const amount = minor(split.amountMinor);
    if ((minor(amountMinor) < 0n && amount > 0n) || (minor(amountMinor) > 0n && amount < 0n)) {
      throw domainError('Splits must have the same sign as the transaction');
    }

    sum += amount;
  }

  if (sum !== minor(amountMinor)) {
    throw domainError('Splits must sum exactly to the transaction amount');
  }
}

export function matchingRule(description, rules = []) {
  return [...rules]
    .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))
    .find((r) => description.toLowerCase().includes(r.contains.toLowerCase()));
}

export function classify(transaction, rules = []) {
  const rule = matchingRule(transaction.description, rules);
  return {
    category: rule?.category || transaction.category || 'Uncategorized',
    kind: rule?.kind || transaction.kind || (minor(transaction.amountMinor) < 0n ? 'expense' : 'income')
  };
}

function add(map, category, value, id, categoryDisplayLabel) {
  const item = map.get(category) || { category, spent: 0n, transactionIds: [] };
  if (categoryDisplayLabel) {
    item.categoryDisplayLabel = categoryDisplayLabel;
  }

  item.spent += value;
  if (!item.transactionIds.includes(id)) {
    item.transactionIds.push(id);
  }

  map.set(category, item);
}

export function calculateReport(transactions, budgets = [], { month, currency = 'AUD' }) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    throw domainError('month must be YYYY-MM');
  }

  const all = transactions.filter((t) => t.currency === currency);
  const included = all.filter((t) => t.date.slice(0, 7) === month);
  let income = 0n,
    expenses = 0n,
    pending = 0n,
    transfers = 0n;
  const categories = new Map(),
    daily = new Map();
  const ids = { income: [], expenses: [], pending: [], transfers: [] };
  for (const t of included) {
    const amount = minor(t.amountMinor);
    if (t.status === 'pending') {
      pending += amount;
      ids.pending.push(t.id);
      continue;
    }

    if (t.kind === 'transfer') {
      transfers += amount;
      ids.transfers.push(t.id);
      continue;
    }

    let day = daily.get(t.date) || { date: t.date, income: 0n, expenses: 0n };
    if (t.kind === 'income') {
      income += amount;
      day.income += amount;
      ids.income.push(t.id);
    } else {
      expenses -= amount;
      day.expenses -= amount;
      ids.expenses.push(t.id);
      for (const s of t.splits?.length
        ? t.splits
        : [
            {
              category: t.category || 'Uncategorized',
              ...(t.categoryDisplayLabel ? { categoryDisplayLabel: t.categoryDisplayLabel } : {}),
              amountMinor: t.amountMinor
            }
          ]) {
        add(categories, s.category, -minor(s.amountMinor), t.id, s.categoryDisplayLabel);
      }
    }

    daily.set(t.date, day);
  }

  const spendingFor = (category, m) =>
    all
      .filter((t) => t.status === 'posted' && t.kind !== 'transfer' && t.kind !== 'income' && t.date.slice(0, 7) === m)
      .reduce(
        (sum, t) =>
          sum +
          (t.splits?.length
            ? t.splits
            : [
                {
                  category: t.category || 'Uncategorized',
                  amountMinor: t.amountMinor
                }
              ]
          )
            .filter((s) => s.category === category)
            .reduce((n, s) => n - minor(s.amountMinor), 0n),
        0n
      );
  const budgetRows = [];
  const grouped = new Map();
  for (const b of budgets
    .filter((b) => b.currency === currency && b.month <= month)
    .sort((a, b) => a.month.localeCompare(b.month))) {
    const previous = grouped.get(b.category);
    // Only an uninterrupted monthly policy rolls forward; negative balances never roll.
    const d = new Date(`${b.month}-01T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() - 1);
    const priorMonth = d.toISOString().slice(0, 7);
    const carry = b.rollover && previous?.month === priorMonth && previous.remaining > 0n ? previous.remaining : 0n;
    const available = minor(b.capMinor) + minor(b.allocationMinor || '0') + carry;
    const spent = spendingFor(b.category, b.month),
      remaining = available - spent;
    grouped.set(b.category, { month: b.month, remaining });
    if (b.month === month) {
      budgetRows.push({
        ...b,
        carryMinor: String(carry),
        availableMinor: String(available),
        spentMinor: String(spent),
        remainingMinor: String(remaining),
        overspent: remaining < 0n,
        transactionIds: categories.get(b.category)?.transactionIds || []
      });
    }
  }

  return {
    month,
    currency,
    incomeMinor: String(income),
    expensesMinor: String(expenses),
    netMinor: String(income - expenses),
    pendingMinor: String(pending),
    transfersMinor: String(transfers),
    transactionIds: ids,
    categories: [...categories.values()]
      .map((c) => ({
        category: c.category,
        ...(c.categoryDisplayLabel ? { categoryDisplayLabel: c.categoryDisplayLabel } : {}),
        spentMinor: String(c.spent),
        transactionIds: c.transactionIds
      }))
      .sort((a, b) =>
        BigInt(a.spentMinor) > BigInt(b.spentMinor)
          ? -1
          : BigInt(a.spentMinor) < BigInt(b.spentMinor)
            ? 1
            : a.category.localeCompare(b.category)
      ),
    daily: [...daily.values()]
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((d) => ({
        date: d.date,
        incomeMinor: String(d.income),
        expensesMinor: String(d.expenses)
      })),
    budgets: budgetRows,
    alerts: budgetRows
      .filter((b) => b.overspent)
      .map((b) => ({
        type: 'overspend',
        category: b.category,
        message: `${b.categoryDisplayLabel || b.category} is over its monthly budget`,
        amountMinor: String(-minor(b.remainingMinor))
      })),
    policy: {
      actuals: 'posted-only',
      refunds: 'Refunds reduce category spending in their posted month; original purchase months are not rewritten.',
      rollover:
        'Positive remainder rolls only across consecutive configured months with rollover enabled. Negative remainder is reset to zero.',
      transfers: 'Transfers and card repayments are excluded from income and expenses.',
      allocations: 'Budget allocations never create bank transactions.'
    }
  };
}

/** Inclusive calendar months; money never passes through floating point. */
export function calculatePeriodReport(
  transactions,
  budgets,
  { month, currency = 'AUD', months = 1, today = new Date().toISOString().slice(0, 10) }
) {
  months = Number(months);
  if (![1, 2, 3, 4, 6].includes(months)) {
    throw domainError('months must be 1, 2, 3, 4 or 6');
  }

  const last = calculateReport(transactions, budgets, { month, currency });
  const monthly = [];
  for (let offset = months - 1; offset >= 0; offset--) {
    const date = new Date(`${month}-01T00:00:00Z`);
    date.setUTCMonth(date.getUTCMonth() - offset);
    const key = date.toISOString().slice(0, 7);
    monthly.push({
      ...calculateReport(transactions, budgets, { month: key, currency }),
      partial: key === today.slice(0, 7)
    });
  }

  const next = new Date(`${month}-01T00:00:00Z`);
  next.setUTCMonth(next.getUTCMonth() + 1);
  next.setUTCDate(0);
  const report = {
    ...last,
    months,
    startDate: `${monthly[0].month}-01`,
    endDate: next.toISOString().slice(0, 10),
    monthly
  };
  return aggregateMonthly(report);
}

function aggregateMonthly(report) {
  const { monthly } = report;
  const last = monthly.at(-1);
  for (const key of ['incomeMinor', 'expensesMinor', 'netMinor', 'pendingMinor', 'transfersMinor']) {
    report[key] = String(monthly.reduce((sum, row) => sum + BigInt(row[key]), 0n));
  }

  report.transactionIds = Object.fromEntries(
    Object.keys(last.transactionIds).map((key) => [key, monthly.flatMap((row) => row.transactionIds[key])])
  );
  const categories = new Map();
  for (const row of monthly) {
    for (const category of row.categories) {
      add(categories, category.category, BigInt(category.spentMinor), null, category.categoryDisplayLabel);
    }
  }

  report.categories = [...categories.values()]
    .map((c) => ({
      category: c.category,
      ...(c.categoryDisplayLabel ? { categoryDisplayLabel: c.categoryDisplayLabel } : {}),
      spentMinor: String(c.spent),
      transactionIds: monthly.flatMap(
        (row) => row.categories.find((item) => item.category === c.category)?.transactionIds || []
      )
    }))
    .sort((a, b) =>
      BigInt(a.spentMinor) > BigInt(b.spentMinor)
        ? -1
        : BigInt(a.spentMinor) < BigInt(b.spentMinor)
          ? 1
          : a.category.localeCompare(b.category)
    );
  report.daily = monthly.flatMap((row) => row.daily);
  report.budgetMonth = report.month;
  return report;
}

/** Summarize exactly an export selection, including arbitrary ranges/all history. */
export function calculateSelectionReport(transactions, { currency = 'AUD', month, from, to } = {}) {
  const selected = transactions.filter((t) => t.currency === currency);
  const keys = [...new Set(selected.map((t) => t.date.slice(0, 7)))].sort();
  if (!keys.length) {
    keys.push(month || (from || to || new Date().toISOString()).slice(0, 7));
  }

  const monthly = keys.map((month) => calculateReport(selected, [], { month, currency }));
  return aggregateMonthly({
    ...monthly.at(-1),
    months: keys.length,
    monthly,
    startDate: from || selected.map((t) => t.date).sort()[0] || null,
    endDate:
      to ||
      selected
        .map((t) => t.date)
        .sort()
        .at(-1) ||
      null
  });
}
