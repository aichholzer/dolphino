import { decimalToMinor } from '../../money.js';

export function transactionCorrection(
  { category, categoryEdited = true, preserveUntouched = false, kind, splits },
  transaction
) {
  const values = splits.map((split) => ({
    category: split.category,
    amountMinor: decimalToMinor(split.amount, transaction.currency)
  }));
  if (
    values.length &&
    values.reduce((total, split) => total + BigInt(split.amountMinor), 0n) !== BigInt(transaction.amountMinor)
  ) {
    throw new Error('Split amounts must add up exactly to the transaction amount, including its sign.');
  }
  const oldSplits = (transaction.splits || []).map(({ category, amountMinor }) => ({ category, amountMinor }));
  return {
    ...(categoryEdited ? { category } : {}),
    ...(!preserveUntouched || kind !== transaction.kind ? { kind } : {}),
    ...(!preserveUntouched || JSON.stringify(values) !== JSON.stringify(oldSplits) ? { splits: values } : {})
  };
}

export function initialTransactionFilters() {
  return {
    search: '',
    category: '',
    status: '',
    kind: '',
    ids: null,
    accountId: '',
    accountName: '',
    allHistory: false,
    from: '',
    to: '',
    txPage: 1
  };
}

export function drilldownFilters(selection, { page, startDate, endDate }) {
  const filters = {
    ...initialTransactionFilters(),
    ids: selection.ids ?? null,
    category: selection.category || '',
    kind: selection.kind || '',
    status: selection.status ?? 'posted'
  };
  if (!selection.month && page === 'Overview' && selection.ids == null && startDate && endDate) {
    filters.from = startDate;
    filters.to = endDate;
  }
  return filters;
}

export function accountTransactionFilters(account) {
  return {
    ...initialTransactionFilters(),
    accountId: account.id,
    accountName: account.name,
    allHistory: true
  };
}
