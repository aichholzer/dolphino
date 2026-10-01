export function PageHeading({ page, session, month, currency, period, setPeriod, onMonthChange, onCurrencyChange }) {
  return (
    <div className="page-heading">
      <div>
        <div className="eyebrow">A LITTLE MORE CLARITY</div>
        <h1>
          {page === 'Overview'
            ? 'Your money, at a glance.'
            : page === 'Transactions'
              ? 'Every little detail.'
              : page === 'Accounts'
                ? 'All your accounts.'
                : page === 'Budgets'
                  ? 'Make room for what matters.'
                  : page === 'Review'
                    ? 'A second look.'
                    : page === 'Rules'
                      ? 'Less sorting. More living.'
                      : 'Your workspace, your way.'}
        </h1>
        <p>
          {
            {
              Overview: 'A clear picture of where you stand and where your money goes.',
              Transactions: 'Search, organize, and make sense of every transaction.',
              Accounts: 'Balances from your bank, with freshness you can see.',
              Budgets: 'Simple monthly limits to keep your priorities in focus.',
              Review: 'Resolve uncertainty before it becomes part of your picture.',
              Rules: 'Consistent categories, automatically applied.',
              Settings: 'Manage your connection and keep your data in your hands.'
            }[page]
          }
        </p>
      </div>
      {['Overview', 'Transactions', 'Budgets'].includes(page) && (
        <div className="period-controls">
          <label className="sr-only" htmlFor="month">
            Reporting month
          </label>
          {page === 'Overview' && (
            <select aria-label="Overview period" value={period} onChange={(e) => setPeriod(Number(e.target.value))}>
              {[1, 2, 3, 4, 6].map((n) => (
                <option key={n} value={n}>
                  {n} {n === 1 ? 'month' : 'months'}
                </option>
              ))}
            </select>
          )}
          <input id="month" type="month" value={month} onChange={(e) => onMonthChange(e.target.value)} />
          <select aria-label="Reporting currency" value={currency} onChange={(e) => onCurrencyChange(e.target.value)}>
            {[...new Set([session?.currency || 'AUD', 'AUD', 'USD', 'EUR', 'GBP', 'NZD'])].map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}
