import { AlertCircle, Plus, ArrowRight } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Empty } from '../../components/empty-state';
import { money } from '../../money.mjs';

export function BudgetsPage({ data, isAdmin, month, currency, onEdit, drill }) {
  const budgets = data.budgets || [];
  return (
    <>
      {data.alerts?.length > 0 && (
        <div className="budget-alerts">
          {data.alerts.map((a, i) => (
            <span key={i} role="status" className="budget-chip">
              <AlertCircle size={14} />
              {a.message} · {money(a.amountMinor, currency)}
            </span>
          ))}
        </div>
      )}
      {!isAdmin && (
        <p className="setup-note">
          Shared budgets show full household category totals. This does not grant access to their underlying
          transactions.
        </p>
      )}
      <div className="section-toolbar">
        <p>
          Category caps · {month} · {currency}
        </p>
        {isAdmin && (
          <Button
            onClick={() =>
              onEdit({
                category: '',
                capMinor: '50000',
                rolloverEnabled: false
              })
            }
          >
            <Plus size={16} />
            Add budget
          </Button>
        )}
      </div>
      <div className="budget-grid">
        {budgets.map((b) => {
          const over = BigInt(b.remainingMinor || 0) < 0n;
          const ratio = Math.min(
            100,
            Math.max(0, (Number(b.spentMinor || 0) / Math.max(1, Number(b.availableMinor || 0))) * 100)
          );
          return (
            <section className="card budget-card" key={b.category}>
              <div className="card-heading">
                <h2>{b.categoryDisplayLabel || b.category}</h2>
                {(isAdmin || b.canEdit || b.access === 'edit') && (
                  <Button variant="outline" onClick={() => onEdit(b)}>
                    Edit
                  </Button>
                )}
              </div>
              <div className="budget-amount">
                {money(b.spentMinor, currency)}
                <span> / {money(b.availableMinor, currency)} allowance</span>
              </div>
              <div className={`progress-track ${over ? 'over' : ''}`}>
                <div style={{ width: `${ratio}%` }} />
              </div>
              <div className="budget-status">
                <span className={over ? 'negative' : 'muted'}>
                  {over ? 'Over budget by ' : ''}
                  {money(over ? (-BigInt(b.remainingMinor)).toString() : b.remainingMinor, currency)}
                  {!over ? ' available' : ''}
                </span>
                {b.rolloverEnabled && <span className="category-tag">Rollover on</span>}
              </div>
              <div className="budget-footer">
                <span>{b.rolloverEnabled ? `Rollover: ${money(b.rolloverMinor, currency)}` : 'Rollover off'}</span>
                {isAdmin && (
                  <button
                    onClick={() =>
                      drill({
                        category: b.category,
                        ids: b.transactionIds
                      })
                    }
                  >
                    View spending <ArrowRight size={13} />
                  </button>
                )}
              </div>
            </section>
          );
        })}
      </div>
      {!budgets.length && (
        <Empty
          title="No budgets yet"
          detail="Add your first monthly category cap. Allocations never create bank expenses."
        />
      )}
      <p className="footnote">
        Positive rollover is opt-in. Overspending does not carry debt into the next month. Late imports and corrections
        recalculate rollovers.
      </p>
    </>
  );
}
