import { money } from '../../money.mjs';
import { accountBalances } from '../../../../shared/account-balances.mjs';
export function BalanceSummary({ accounts = [] }) {
  return (
    <section className="card balance-summary" aria-label="Active account balances">
      <h2>Active account balances</h2>
      <div className="balance-totals">
        {accountBalances(accounts).map((row) => (
          <div key={row.currency}>
            <strong>{money(row.balanceMinor, row.currency)}</strong>
            <span>
              {row.currency} · {row.accountCount} accounts
              {row.unknownBalances ? ` · ${row.unknownBalances} balances unavailable` : ''}
            </span>
          </div>
        ))}
      </div>
      <p className="footnote">
        Includes active manual book balances and feed snapshots. Frozen accounts are excluded. Currencies stay separate.
      </p>
    </section>
  );
}
