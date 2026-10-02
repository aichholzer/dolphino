import { initialTransactionFilters } from '../features/transactions/transaction-model.mjs';

// URLs contain criteria, never results, account names or permissions.
export function readTransactionRoute(query, defaults) {
  const params = new URLSearchParams(query || '');
  const filters = initialTransactionFilters();
  for (const [key, limit] of [
    ['search', 200],
    ['accountId', 200],
    ['category', 100],
    ['tag', 40]
  ]) {
    filters[key] = (params.get(key) || '').slice(0, limit);
  }

  if (params.get('includeVoided') === 'true') {
    filters.includeVoided = true;
  }

  filters.allHistory = params.get('allHistory') === 'true';
  for (const key of ['from', 'to']) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(params.get(key) || '')) {
      filters[key] = params.get(key);
    }
  }

  if (['posted', 'pending'].includes(params.get('status'))) {
    filters.status = params.get('status');
  }

  if (['expense', 'income', 'transfer', 'refund', 'opening', 'adjustment'].includes(params.get('kind'))) {
    filters.kind = params.get('kind');
  }

  if (params.has('ids')) {
    filters.ids = params
      .get('ids')
      .split(',')
      .filter((id) => /^[a-f\d-]{36}$/i.test(id))
      .slice(0, 1000);
  }

  const page = Number(params.get('page'));
  if (Number.isInteger(page) && page >= 1 && page <= 1000000) {
    filters.txPage = page;
  }

  return {
    filters,
    month: /^\d{4}-(0[1-9]|1[0-2])$/.test(params.get('month') || '') ? params.get('month') : defaults.month,
    currency: /^[A-Z]{3}$/.test(params.get('currency') || '') ? params.get('currency') : defaults.currency
  };
}

export function writeTransactionRoute(filters, { month, currency }) {
  const params = new URLSearchParams({ currency });
  if (!filters.allHistory && !filters.from && !filters.to && filters.ids === null) {
    params.set('month', month);
  }

  for (const key of ['search', 'accountId', 'category', 'tag', 'status', 'kind', 'from', 'to']) {
    if (filters[key]) {
      params.set(key, filters[key]);
    }
  }

  if (filters.includeVoided) {
    params.set('includeVoided', 'true');
  }

  if (filters.allHistory) {
    params.set('allHistory', 'true');
  }

  if (filters.ids !== null) {
    params.set('ids', filters.ids.join(','));
  }

  if (filters.txPage > 1) {
    params.set('page', filters.txPage);
  }

  return params.toString();
}
