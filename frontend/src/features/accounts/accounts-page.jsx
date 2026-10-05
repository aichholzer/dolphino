import { BalanceSummary } from './balance-summary';
import { ArrowRight, Clock, Plus } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Empty } from '../../components/empty-state';
import { money } from '../../money.mjs';
import { formatStamp } from '../../lib/dates.mjs';
import { stateLabel } from '../../lib/labels.mjs';

export function AccountsPage({ accounts, canEditAccount, onEdit, onViewTransactions, isAdmin, onManual }) {
  return (
    <>
      <BalanceSummary accounts={accounts} />
      {isAdmin && (
        <div className="section-toolbar">
          <Button onClick={() => onManual({ type: 'account' })}>
            <Plus size={16} />
            Add manual account
          </Button>
        </div>
      )}
      <div className="account-grid">
        {accounts.map((a) => (
          <section className="card account-card" key={a.id}>
            <div className="account-heading">
              <div className="account-controls">
                {!a.frozen && (a.canEdit || canEditAccount(a.id)) && (
                  <Button variant="outline" aria-label={`Edit account ${a.name}`} onClick={() => onEdit(a)}>
                    Edit
                  </Button>
                )}
              </div>
            </div>
            <button
              className="account-open"
              aria-label={`View transactions for ${a.name}`}
              onClick={() => onViewTransactions(a)}
            >
              <h2>{a.name}</h2>
              <p>{a.description || a.institution || (a.sourceType === 'manual' ? 'Manual account' : 'Feed account')}</p>
              <span className="account-open-label">
                View transactions <ArrowRight size={14} />
              </span>
            </button>
            <p className={`status-pill ${a.frozen ? 'frozen' : ''}`}>
              {a.sourceType === 'manual' ? 'Manual' : 'Feed'}
              {a.frozen ? ' · Frozen · balance excluded' : ' · Active'}
            </p>
            <div className="account-balance">{a.balanceMinor == null ? '—' : money(a.balanceMinor, a.currency)}</div>
            {(a.canEdit || canEditAccount(a.id)) && (
              <div className="account-actions">
                {a.sourceType === 'manual' && !a.frozen && (
                  <>
                    {[
                      ['activity', 'Add entry'],
                      ['transfer', 'Transfer'],
                      ['adjustment', 'Adjust balance']
                    ].map(([type, label]) => (
                      <Button key={type} variant="outline" onClick={() => onManual({ type, account: a })}>
                        {type === 'activity' && <Plus size={16} />}
                        {label}
                      </Button>
                    ))}
                  </>
                )}
                <Button
                  variant="outline"
                  onClick={() => onManual({ type: 'lifecycle', action: a.frozen ? 'unfreeze' : 'freeze', account: a })}
                >
                  {a.frozen ? 'Unfreeze' : 'Freeze'}
                </Button>
                <Button variant="outline" onClick={() => onManual({ type: 'lifecycle', action: 'delete', account: a })}>
                  Delete account
                </Button>
              </div>
            )}
            <div className="account-meta">
              <span>
                {stateLabel(a.balanceType || 'reported')} balance ·{' '}
                {a.coverage?.source === 'pocketsmith' && a.coverage.balanceDate
                  ? `Provider balance date ${a.coverage.balanceDate}`
                  : a.balanceAt
                    ? formatStamp(a.balanceAt)
                    : 'No balance timestamp'}
              </span>
              <span>
                <Clock size={14} />
                {a.sourceType === 'manual'
                  ? 'Entered locally · no feed'
                  : a.fetchedAt
                    ? `Synced ${formatStamp(a.fetchedAt)}`
                    : 'Not yet synced'}
              </span>
              <span>{a.reconciliationReason || 'Not reconciled: no compatible balance coverage.'}</span>
            </div>
          </section>
        ))}
      </div>
      {!accounts.length && (
        <Empty
          title="No accounts yet"
          detail="Ask an administrator to create a manual account or connect a feed in Settings."
        />
      )}
      <p className="footnote">
        Bank balances are provider snapshots. They do not prove the accuracy of imported transaction totals. Account
        discovery runs every four hours. Your financial picture includes the accounts you are permitted to view.
      </p>
    </>
  );
}
