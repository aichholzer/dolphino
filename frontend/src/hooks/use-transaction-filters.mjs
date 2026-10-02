import { useCallback, useEffect, useMemo, useState } from 'react';
import { initialTransactionFilters } from '../features/transactions/transaction-model.mjs';
import { readTransactionRoute, writeTransactionRoute } from '../lib/transaction-route.mjs';

export function useTransactionFilters(month, currency, { page, transactionQuery, changeRoute }) {
  const [remembered, setRemembered] = useState(initialTransactionFilters);
  const route = useMemo(
    () => readTransactionRoute(transactionQuery, { month, currency }),
    [transactionQuery, month, currency]
  );
  const filters = page === 'Transactions' ? route.filters : remembered;
  useEffect(() => {
    if (page === 'Transactions') {
      setRemembered(route.filters);
    }
  }, [page, route.filters]);
  const updateFilters = useCallback(
    (changes, controls = {}) => {
      const next = { ...filters, ...changes, txPage: changes.txPage || 1 };
      if (page === 'Transactions') {
        changeRoute('Transactions', undefined, {
          replace: true,
          transactionQuery: writeTransactionRoute(next, {
            month: controls.month || route.month,
            currency: controls.currency || route.currency
          })
        });
      } else {
        setRemembered(next);
      }
    },
    [filters, page, changeRoute, route.month, route.currency]
  );
  return {
    filters,
    updateFilters,
    routeMonth: page === 'Transactions' ? route.month : month,
    routeCurrency: page === 'Transactions' ? route.currency : currency
  };
}
