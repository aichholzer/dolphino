export function reportingMonth(session, now = new Date()) {
  if (!session) {
    return now.toISOString().slice(0, 7);
  }

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: session.timeZone || 'Australia/Brisbane',
    year: 'numeric',
    month: '2-digit'
  }).formatToParts(now);
  return `${parts.find((part) => part.type === 'year').value}-${parts.find((part) => part.type === 'month').value}`;
}

export function reportQuery({ page, month, currency, period, filters }) {
  const { txPage, accountId, allHistory, from, to, search, category, tag, status, kind, ids } = filters;
  return new URLSearchParams({
    // An explicit ID set includes []: an empty drilldown must never become a whole month.
    ...(page === 'Transactions' && (allHistory || from || to || ids !== null) ? {} : { month }),
    currency,
    ...(page === 'Overview' ? { months: String(period) } : {}),
    ...(page === 'Transactions'
      ? {
          page: String(txPage),
          pageSize: '50',
          ...(accountId ? { accountId } : {}),
          ...(allHistory ? { allHistory: 'true' } : {}),
          ...(from ? { from } : {}),
          ...(to ? { to } : {})
        }
      : {}),
    ...(search ? { search } : {}),
    ...(category ? { category } : {}),
    ...(tag ? { tag } : {}),
    ...(status ? { status } : {}),
    ...(kind ? { kind } : {}),
    ...(ids !== null ? { ids: ids.join(',') } : {})
  }).toString();
}

export function reportPath(page, query) {
  switch (page) {
    case 'Overview':
      return `/dashboard?${query}`;
    case 'Transactions':
      return `/transactions?${query}`;
    case 'Accounts':
      return '/accounts';
    case 'Budgets':
      return `/budgets?${query}`;
    case 'Review':
      return '/reviews';
    case 'Rules':
      return '/rules';
    default:
      return '/settings';
  }
}
