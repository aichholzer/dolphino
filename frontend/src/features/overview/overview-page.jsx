import { useEffect, useState } from 'react';
import { AlertCircle, ChevronRight, ArrowUpRight, ArrowLeftRight, Clock, ArrowRight, Inbox } from 'lucide-react';
import { BalanceSummary } from '../accounts/balance-summary';
import { api } from '../../lib/api.mjs';
import { money } from '../../money.mjs';
import { Empty } from '../../components/empty-state';
import { formatStamp } from '../../lib/dates.mjs';

export function OverviewPage({ data, isAdmin, canReview, month, period, currency, navigate, drill }) {
  const reviewCount = useReviewCount(canReview);
  return (
    <>
      <BalanceSummary accounts={data.accounts || []} />
      {(data.alerts?.length > 0 || reviewCount > 0) && (
        <div className="budget-alerts">
          {data.alerts?.map((a, i) => (
            <button key={i} onClick={() => navigate('Budgets')}>
              <AlertCircle size={14} />
              {a.message} · {money(a.amountMinor, currency)}
              <ChevronRight size={13} />
            </button>
          ))}
          {reviewCount > 0 && (
            <button className="review-chip" onClick={() => navigate('Review')}>
              <Inbox size={14} />
              {reviewCount} {reviewCount === 1 ? 'transaction needs' : 'transactions need'} review
              <ChevronRight size={13} />
            </button>
          )}
        </div>
      )}
      {!isAdmin && (
        <p className="setup-note">Overview totals include only accounts shared with you. Budget access is separate.</p>
      )}
      <p className="period-caption">
        {data.startDate || data.monthly?.[0]?.month || month} to {data.endDate || month} · {period}{' '}
        {period === 1 ? 'month' : 'months'}
      </p>
      <div className="metric-grid">
        <Metric
          title="Total income"
          value={money(data.incomeMinor, currency)}
          subtitle="Posted income in selected period"
          onClick={() => drill({ ids: data.transactionIds?.income })}
        />
        <Metric
          title="Total spending"
          value={money(data.expensesMinor, currency)}
          subtitle="Transfers excluded · refunds included"
          onClick={() => drill({ ids: data.transactionIds?.expenses })}
        />
        <Metric
          title="Net cash flow"
          value={money(data.netMinor, currency)}
          subtitle="Income minus spending"
          onClick={() =>
            drill({
              ids: [...(data.transactionIds?.income || []), ...(data.transactionIds?.expenses || [])]
            })
          }
        />
      </div>
      {data.monthly?.length > 0 && (
        <section className="card monthly-comparison">
          <div className="card-heading">
            <div>
              <h2>Month by month</h2>
              <p>Compare posted activity. Select a total to see its transactions.</p>
            </div>
          </div>
          <div
            className="table-wrap monthly-comparison-scroll"
            role="region"
            aria-label="Month-by-month comparison. Scroll horizontally to view all columns."
            tabIndex={0}
          >
            <table>
              <thead>
                <tr>
                  <th>Month</th>
                  <th>Income</th>
                  <th>Spending</th>
                  <th>Net cash flow</th>
                  <th>Spending change</th>
                </tr>
              </thead>
              <tbody>
                {data.monthly.map((r, i, rows) => (
                  <tr key={r.month}>
                    <td>
                      {r.month} {r.partial && <span className="category-tag">Partial month</span>}
                    </td>
                    {['income', 'expenses', 'net'].map((k) => (
                      <td key={k}>
                        <button
                          className="total-drill"
                          onClick={() =>
                            drill({
                              month: r.month,
                              ids:
                                k === 'net'
                                  ? [...(r.transactionIds?.income || []), ...(r.transactionIds?.expenses || [])]
                                  : r.transactionIds?.[k]
                            })
                          }
                        >
                          {money(r[`${k}Minor`], currency)}
                        </button>
                      </td>
                    ))}
                    <td>
                      {i
                        ? money(
                            (BigInt(r.expensesMinor || 0) - BigInt(rows[i - 1].expensesMinor || 0)).toString(),
                            currency
                          )
                        : '—'}
                      {i > 0 && (r.partial || rows[i - 1].partial) ? ' · partial comparison' : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="table-scroll-hint">
            <ArrowLeftRight size={14} aria-hidden="true" />
            Scroll sideways to compare all columns
          </p>
        </section>
      )}
      <div className="chart-grid">
        <section className="card">
          <div className="card-heading">
            <div>
              <h2>Money in, money out</h2>
              <p>Daily activity · striped bars are net refunds</p>
            </div>
            <div className="legend">
              <span className="legend-income" />
              Income
              <span className="legend-expense" />
              Spending
            </div>
          </div>
          <CashChart rows={data.trend || []} start={data.startDate} end={data.endDate} currency={currency} />
        </section>
        <section className="card">
          <div className="card-heading">
            <div>
              <h2>Where it went</h2>
              <p>Posted spending by category</p>
            </div>
            <button
              className="icon-link"
              aria-label="View all spending"
              onClick={() => drill({ ids: data.transactionIds?.expenses })}
            >
              <ArrowUpRight size={20} />
            </button>
          </div>
          <CategoryChart
            rows={data.categories || []}
            currency={currency}
            onSelect={(category, ids) =>
              drill(
                category
                  ? { category, ids: data.categories?.find((c) => c.category === category)?.transactionIds }
                  : { ids }
              )
            }
          />
        </section>
      </div>
      <div className="overview-bottom">
        <section className="card coverage-card">
          <div>
            <h2>Freshness and coverage</h2>
            <p>
              {data.coverage?.reason ||
                'Totals include imported posted transactions for this month and currency. Bank balances are separate snapshots.'}
            </p>
            <div className="coverage-meta">
              <span>
                <Clock size={13} />
                {data.coverage?.fetchedAt
                  ? `Updated ${formatStamp(data.coverage.fetchedAt)}`
                  : 'Freshness depends on your bank connection'}
              </span>
              <button onClick={() => navigate('Accounts')}>
                View coverage <ArrowRight size={13} />
              </button>
            </div>
          </div>
        </section>
        <section className="card pending-card">
          <h2>Pending transactions</h2>
          <strong>{money(data.pendingMinor, currency)}</strong>
          <p>Shown separately until posted.</p>
          <button onClick={() => drill({ status: 'pending' })}>
            See pending <ArrowRight size={14} />
          </button>
        </section>
      </div>
    </>
  );
}

function useReviewCount(enabled) {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!enabled) {
      return undefined;
    }

    let live = true;
    api('/reviews')
      .then((result) => live && setCount(result.reviews?.length ?? 0))
      .catch(() => live && setCount(0));
    return () => {
      live = false;
    };
  }, [enabled]);
  return count;
}

function Metric({ title, value, subtitle, onClick }) {
  return (
    <button className="card metric" onClick={onClick}>
      <div className="metric-top">
        <span>{title}</span>
      </div>
      <strong>{value}</strong>
      <div className="metric-bottom">
        <span>{subtitle}</span>
        <ArrowRight size={14} />
      </div>
    </button>
  );
}

const DAY = 86400000;
const utc = (date) => Date.parse(`${date}T00:00:00Z`);
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const monthName = new Intl.DateTimeFormat('en-AU', { month: 'short', timeZone: 'UTC' });

// One column per calendar day, so quiet days keep their place on the time axis.
function calendarDays(rows, start, end) {
  if (!rows.length) {
    return [];
  }

  const byDate = new Map(rows.map((r) => [r.date || r.label, r]));
  const first = utc(start || rows[0].date || rows[0].label);
  const lastRow = utc(rows.at(-1).date || rows.at(-1).label);
  const today = utc(new Date().toLocaleDateString('en-CA'));
  const last = Math.max(lastRow, Math.min(Math.max(today, first), end ? utc(end) : lastRow));
  const days = [];
  for (let at = first; at <= last && days.length < 400; at += DAY) {
    const date = isoDay(at);
    const row = byDate.get(date);
    days.push({ date, incomeMinor: row?.incomeMinor || '0', expensesMinor: row?.expensesMinor || '0' });
  }

  return days;
}

const whole = (minor, currency) => money(String(Math.round(minor / 100) * 100), currency).replace(/\.00$/, '');

function CashChart({ rows, start, end, currency }) {
  const days = calendarDays(rows, start, end);
  const peak = Math.max(
    1,
    ...days.flatMap((r) => [Math.abs(Number(r.incomeMinor || 0)), Math.abs(Number(r.expensesMinor || 0))])
  );
  // Three even gridline steps on a round number, so the axis reads $2,500 · $5,000 · $7,500.
  const raw = peak / 3;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s >= raw);
  const max = step * 3;
  const height = (value) => {
    const amount = Math.abs(Number(value || 0));
    return amount ? `${Math.max(2, (amount / max) * 100)}%` : '0';
  };

  const label = (day, i) => {
    if (days.length > 62) {
      return day.date.endsWith('-01') ? monthName.format(utc(day.date)) : '';
    }

    return i % 7 === 0 ? day.date.slice(8) : '';
  };

  return (
    <div className="cash-chart">
      <div className="chart-grid-lines">
        <span />
        <span />
        <span />
        <span />
      </div>
      {days.length ? (
        <>
          <div className="chart-axis" aria-hidden="true">
            <span>{whole(max, currency)}</span>
            <span>{whole((max * 2) / 3, currency)}</span>
            <span>{whole(max / 3, currency)}</span>
            <span />
          </div>
          <div className="chart-bars" style={{ gap: days.length > 45 ? '1px' : '5px' }} aria-hidden="true">
            {days.map((r, i) => (
              <div key={r.date} className="chart-column">
                <div className="bar-pair">
                  <div
                    className="bar income-bar"
                    title={`${r.date} income ${money(r.incomeMinor, currency)}`}
                    style={{ height: height(r.incomeMinor) }}
                  />
                  <div
                    className={`bar expense-bar ${BigInt(r.expensesMinor || 0) < 0n ? 'refund-bar' : ''}`}
                    title={`${r.date} ${BigInt(r.expensesMinor || 0) < 0n ? 'refund reduces spending' : 'spending'} ${money(r.expensesMinor, currency)}`}
                    style={{ height: height(r.expensesMinor) }}
                  />
                </div>
                <span>{label(r, i)}</span>
              </div>
            ))}
          </div>
          <div className="sr-only">
            <table>
              <caption>Daily posted income and spending</caption>
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col">Income</th>
                  <th scope="col">Spending</th>
                </tr>
              </thead>
              <tbody>
                {days
                  .filter((r) => BigInt(r.incomeMinor || 0) !== 0n || BigInt(r.expensesMinor || 0) !== 0n)
                  .map((r) => (
                    <tr key={r.date}>
                      <td>{r.date}</td>
                      <td>{money(r.incomeMinor, currency)}</td>
                      <td>{money(r.expensesMinor, currency)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <div className="chart-empty">No posted activity in this period.</div>
      )}
    </div>
  );
}

function CategoryChart({ rows, currency, onSelect }) {
  const colors = [
    'var(--chart-ocean)',
    'var(--chart-sea)',
    'var(--chart-coral)',
    'var(--chart-sky)',
    'var(--chart-sun)',
    'var(--chart-tide)'
  ];
  const shown = rows.slice(0, 6);
  const rest = rows.slice(6);
  const other = rest.reduce((sum, r) => sum + BigInt(r.amountMinor || 0), 0n);
  const max = Math.max(1, ...rows.map((r) => Math.abs(Number(r.amountMinor || 0))));
  return (
    <div className="category-chart">
      {shown.map((r, i) => (
        <button key={r.category} onClick={() => onSelect(r.category)} className="category-row">
          <div className="category-line">
            <span>
              <i style={{ background: colors[i % colors.length] }} />
              {r.categoryDisplayLabel || r.category}
            </span>
            <strong>{money(r.amountMinor, currency)}</strong>
          </div>
          <div className="category-track">
            <div
              style={{
                background: colors[i % colors.length],
                width: `${(Math.abs(Number(r.amountMinor || 0)) / max) * 100}%`
              }}
            />
          </div>
        </button>
      ))}
      {rest.length > 0 && (
        <button
          className="category-row other"
          onClick={() =>
            onSelect(
              null,
              rest.flatMap((r) => r.transactionIds || [])
            )
          }
        >
          <div className="category-line">
            <span>
              <i />
              Other · {rest.length} {rest.length === 1 ? 'category' : 'categories'}
            </span>
            <strong>{money(other.toString(), currency)}</strong>
          </div>
        </button>
      )}
      {!rows.length && (
        <Empty
          title="No spending yet"
          detail="Category totals appear when posted expenses are imported for this period."
        />
      )}
    </div>
  );
}
