import { formatStamp } from '../lib/dates.mjs';

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// The line under each headline states what is on the page right now, from the loaded report.
function pageDetail(page, data) {
  switch (page) {
    case 'Overview': {
      if (!data.accounts || data.incomeMinor === undefined) {
        return '';
      }

      const active = data.accounts.filter((a) => a.includedInBalance !== false && !a.frozen && !a.deleted);
      const synced = active
        .map((a) => a.fetchedAt)
        .filter(Boolean)
        .sort()
        .at(-1);
      return [plural(active.length, 'active account'), synced && `feeds updated ${formatStamp(synced)}`]
        .filter(Boolean)
        .join(' · ');
    }

    case 'Transactions':
      return data.transactions ? plural(data.total ?? data.transactions.length, 'transaction') : '';
    case 'Accounts': {
      if (!data.accounts) {
        return '';
      }

      const manual = data.accounts.filter((a) => a.sourceType === 'manual').length;
      return [
        plural(data.accounts.length, 'account'),
        plural(data.accounts.length - manual, 'bank feed'),
        `${manual} manual`
      ].join(' · ');
    }

    case 'Budgets': {
      if (!data.budgets) {
        return '';
      }

      const over = data.budgets.filter((b) => BigInt(b.remainingMinor || 0) < 0n).length;
      return data.budgets.length ? `${plural(data.budgets.length, 'budget')} · ${over} over` : 'No budgets yet';
    }

    case 'Review':
      if (!data.reviews) {
        return '';
      }

      return data.reviews.length ? `${plural(data.reviews.length, 'item')} to review` : 'Nothing to review';
    case 'Rules':
      return data.rules ? `${plural(data.rules.length, 'rule')} · the first match wins` : '';
    default:
      return 'Bank feeds, categories, members, notifications, data and AI features';
  }
}

export function PageHeading({
  page,
  data = {},
  session,
  month,
  currency,
  period,
  setPeriod,
  onMonthChange,
  onCurrencyChange
}) {
  const detail = pageDetail(page, data);
  return (
    <div className="page-heading">
      <div>
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
        <p className="page-detail">{detail}</p>
      </div>
      {['Overview', 'Transactions', 'Budgets'].includes(page) && (
        <div className="period-controls">
          <label className="sr-only" htmlFor="month">
            Reporting month
          </label>
          {page === 'Overview' && (
            <select aria-label="Overview period" value={period} onChange={(e) => setPeriod(Number(e.target.value))}>
              {[1, 2, 3, 4, 5, 6].map((n) => (
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
