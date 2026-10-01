import { Landmark, ArrowRight, Clock } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Empty } from '../../components/empty-state';
import { money } from '../../money.js';

export function AccountsPage({ accounts, canEditAccount, onEdit, onViewTransactions }) {
  return (
    <>
      <div className="account-grid">
        {accounts.map((a) => (
          <section className="card account-card" key={a.id}>
            <div className="account-heading">
              <div className="bank-icon">
                <Landmark size={24} />
              </div>
              <div className="account-controls">
                {(a.canEdit || canEditAccount(a.id)) && (
                  <Button variant="ghost" size="sm" aria-label={`Edit account ${a.name}`} onClick={() => onEdit(a)}>
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
              <p>{a.description || a.institution || 'Connected account'}</p>
              <span className="account-open-label">
                View transactions <ArrowRight size={14} />
              </span>
            </button>
            <div className="account-balance">{a.balanceMinor == null ? '—' : money(a.balanceMinor, a.currency)}</div>
            <div className="account-meta">
              <span>
                {a.balanceType || 'Reported'} balance ·{' '}
                {a.balanceAt ? new Date(a.balanceAt).toLocaleString() : 'No balance timestamp'}
              </span>
              <span>
                <Clock size={14} />
                {a.fetchedAt ? new Date(a.fetchedAt).toLocaleString() : 'Not yet synced'}
              </span>
              <span>{a.reconciliationReason || 'Not reconciled: no compatible balance coverage.'}</span>
            </div>
          </section>
        ))}
      </div>
      {!accounts.length && (
        <Empty
          title="No accounts yet"
          detail="Ask an administrator to configure Redbark and test the connection in Settings."
        />
      )}
      <p className="footnote">
        Bank balances are provider snapshots. They do not prove the accuracy of imported transaction totals. Account
        discovery runs every four hours. Your financial picture includes the accounts you are permitted to view.
      </p>
    </>
  );
}
