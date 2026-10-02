import {
  AlertCircle,
  ChevronRight,
  ArrowDownLeft,
  ArrowUpRight,
  ChartNoAxesCombined,
  ArrowLeftRight,
  ShieldCheck,
  Clock,
  ArrowRight
} from 'lucide-react';
import { money } from '../../money.mjs';
import { Empty } from '../../components/empty-state';

export function OverviewPage({ data, isAdmin, month, period, currency, navigate, drill }) {
  return (
    <>
      {data.alerts?.length > 0 && (
        <div className="budget-alerts">
          {data.alerts.map((a, i) => (
            <button key={i} onClick={() => navigate('Budgets')}>
              <AlertCircle size={14} />
              {a.message} · {money(a.amountMinor, currency)}
              <ChevronRight size={13} />
            </button>
          ))}
        </div>
      )}
      {!isAdmin && (
        <p className="setup-note">Overview totals include only accounts shared with you. Budget access is separate.</p>
      )}
      <p className="period-caption">
        {data.startDate || data.monthly?.[0]?.month || month} — {data.endDate || month} · {period}{' '}
        {period === 1 ? 'month' : 'months'}
      </p>
      <div className="metric-grid">
        <Metric
          title="Total income"
          value={money(data.incomeMinor, currency)}
          subtitle="Posted income in selected period"
          icon={ArrowDownLeft}
          color="green"
          onClick={() => drill({ ids: data.transactionIds?.income })}
        />
        <Metric
          title="Total spending"
          value={money(data.expensesMinor, currency)}
          subtitle="Transfers excluded · refunds included"
          icon={ArrowUpRight}
          color="orange"
          onClick={() => drill({ ids: data.transactionIds?.expenses })}
        />
        <Metric
          title="Net cash flow"
          value={money(data.netMinor, currency)}
          subtitle="Income minus spending"
          icon={ChartNoAxesCombined}
          color="ocean"
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
          <CashChart rows={data.trend || []} currency={currency} />
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
            onSelect={(category) =>
              drill({
                category,
                ids: data.categories?.find((c) => c.category === category)?.transactionIds
              })
            }
          />
        </section>
      </div>
      <div className="overview-bottom">
        <section className="card coverage-card">
          <div className="coverage-icon">
            <ShieldCheck size={24} />
          </div>
          <div>
            <h2>A picture you can trust</h2>
            <p>
              {data.coverage?.reason ||
                'Totals include imported posted transactions for this month and currency. Bank balances are separate snapshots.'}
            </p>
            <div className="coverage-meta">
              <span>
                <Clock size={13} />
                {data.coverage?.fetchedAt
                  ? `Updated ${new Date(data.coverage.fetchedAt).toLocaleString()}`
                  : 'Freshness depends on your bank connection'}
              </span>
              <button onClick={() => navigate('Accounts')}>
                View coverage <ArrowRight size={13} />
              </button>
            </div>
          </div>
        </section>
        <section className="card pending-card">
          <span className="label">PENDING TRANSACTIONS</span>
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

function Metric({ title, value, subtitle, icon: Icon, color, onClick }) {
  return (
    <button className="card metric" onClick={onClick}>
      <div className="metric-top">
        <span>{title}</span>
        <div className={`metric-icon ${color}`}>
          <Icon size={18} />
        </div>
      </div>
      <strong>{value}</strong>
      <div className="metric-bottom">
        <span>{subtitle}</span>
        <ArrowRight size={14} />
      </div>
    </button>
  );
}

function CashChart({ rows, currency }) {
  const max = Math.max(
    1,
    ...rows.flatMap((r) => [Math.abs(Number(r.incomeMinor || 0)), Math.abs(Number(r.expensesMinor || 0))])
  );
  return (
    <div className="cash-chart">
      <div className="chart-grid-lines">
        <span />
        <span />
        <span />
        <span />
      </div>
      {rows.length ? (
        <div className="chart-bars">
          {rows.map((r, i) => (
            <div key={i} className="chart-column">
              <div className="bar-pair">
                <div
                  className="bar income-bar"
                  title={`Income ${money(r.incomeMinor, currency)}`}
                  style={{
                    height: `${Math.max(2, (Math.abs(Number(r.incomeMinor || 0)) / max) * 100)}%`
                  }}
                />
                <div
                  className={`bar expense-bar ${BigInt(r.expensesMinor || 0) < 0n ? 'refund-bar' : ''}`}
                  title={`${BigInt(r.expensesMinor || 0) < 0n ? 'Refund reduces spending' : 'Spending'} ${money(r.expensesMinor, currency)}`}
                  style={{
                    height: `${Math.max(2, (Math.abs(Number(r.expensesMinor || 0)) / max) * 100)}%`
                  }}
                />
              </div>
              <span>{rows.length > 15 ? (i % 5 === 0 ? r.label.slice(-2) : '') : r.label.slice(5)}</span>
            </div>
          ))}
        </div>
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
  const max = Math.max(1, ...rows.map((r) => Math.abs(Number(r.amountMinor || 0))));
  return (
    <div className="category-chart">
      {rows.slice(0, 6).map((r, i) => (
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
      {!rows.length && (
        <Empty
          title="Room for your next chapter"
          detail="Category spending appears when posted expenses are imported."
        />
      )}
    </div>
  );
}
