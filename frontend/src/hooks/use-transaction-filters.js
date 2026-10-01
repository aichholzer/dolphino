import { useCallback, useEffect, useState } from 'react';
import { initialTransactionFilters } from '../features/transactions/transaction-model.js';

export function useTransactionFilters(month, currency) {
  const [filters, setFilters] = useState(initialTransactionFilters);
  const updateFilters = useCallback((changes) => {
    setFilters((current) => ({ ...current, ...changes }));
  }, []);
  const { search, category, status, kind, ids, accountId, allHistory, from, to } = filters;
  useEffect(() => {
    updateFilters({ txPage: 1 });
  }, [search, category, status, kind, ids, month, accountId, allHistory, from, to, currency, updateFilters]);
  return { filters, updateFilters };
}
