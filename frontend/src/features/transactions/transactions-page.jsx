import { Search, Download, ArrowDownLeft, ArrowUpRight } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Empty } from '../../components/empty-state';
import { money } from '../../money.mjs';
import { CategorySelect } from '../../components/category-select';
import { useCategoryOptions } from '../../hooks/use-category-options.mjs';

export function TransactionsPage({
  data,
  currency,
  query,
  isAdmin,
  navigate,
  canEditAccount,
  onEdit,
  onCreateRule,
  filters,
  onFiltersChange
}) {
  const transactions = data.transactions || [];
  const options = useCategoryOptions();
  const { accountId, accountName, allHistory, from, to, search, category, tag, status, kind, ids, txPage } = filters;
  return (
    <section className="card transactions-card">
      <p className="footnote" style={{ padding: '16px 20px 0' }}>
        History includes records already imported into dolphino. For older provider records, use{' '}
        <button type="button" onClick={() => navigate('Settings', 'data')}>
          {isAdmin
            ? 'Settings → Data → Import health & history → backfill'
            : 'Ask your administrator to import more history'}
        </button>
        .
      </p>
      <div className="table-toolbar">
        <div className="transaction-scope">
          {accountId && (
            <strong>
              {accountName ||
                transactions.find((transaction) => transaction.accountId === accountId)?.accountName ||
                'Selected account'}{' '}
              <button
                onClick={() => {
                  onFiltersChange({ accountId: '', accountName: '' });
                }}
              >
                Clear account
              </button>
            </strong>
          )}
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={allHistory}
              onChange={(e) => {
                onFiltersChange({ allHistory: e.target.checked, from: '', to: '', ids: null });
              }}
            />
            All imported history
          </label>
          <label>
            From
            <input
              type="date"
              aria-label="Transactions from"
              value={from}
              onChange={(e) => {
                onFiltersChange({ from: e.target.value, allHistory: false, ids: null });
              }}
            />
          </label>
          <label>
            To
            <input
              type="date"
              aria-label="Transactions to"
              value={to}
              onChange={(e) => {
                onFiltersChange({ to: e.target.value, allHistory: false, ids: null });
              }}
            />
          </label>
        </div>
        <div className="search-input">
          <Search size={17} />
          <input
            aria-label="Search transactions"
            placeholder="Search descriptions, categories or tags…"
            maxLength={200}
            value={search}
            onChange={(e) => onFiltersChange({ search: e.target.value })}
          />
        </div>
        <CategorySelect
          aria-label="Filter category"
          catalog={options.catalog}
          includeArchived
          value={category}
          placeholder="All categories"
          onChange={(e) => onFiltersChange({ category: e.target.value })}
        />
        <select aria-label="Filter tag" value={tag || ''} onChange={(e) => onFiltersChange({ tag: e.target.value })}>
          <option value="">All tags</option>
          {tag && !options.tags.includes(tag) && <option value={tag}>{tag}</option>}
          {options.tags.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        {options.error && (
          <p role="alert" className="negative">
            Filter options could not be loaded: {options.error}
          </p>
        )}
        <select aria-label="Filter status" value={status} onChange={(e) => onFiltersChange({ status: e.target.value })}>
          <option value="">All statuses</option>
          <option value="posted">Posted</option>
          <option value="pending">Pending</option>
        </select>
        <select aria-label="Filter type" value={kind} onChange={(e) => onFiltersChange({ kind: e.target.value })}>
          <option value="">All types</option>
          {['expense', 'income', 'transfer', 'refund'].map((k) => (
            <option key={k}>{k}</option>
          ))}
        </select>
        <Button asChild variant="outline">
          <a href={`/api/export?${query}`}>
            <Download size={15} />
            Export
          </a>
        </Button>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Transaction</th>
              <th>Date</th>
              <th>Category</th>
              <th>Account</th>
              <th className="align-right">Amount</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {transactions.map((t) => (
              <tr key={t.id}>
                <td>
                  <div className="transaction-name">
                    <div className={`transaction-icon ${t.kind === 'income' ? 'green' : ''}`}>
                      {t.kind === 'income' ? <ArrowDownLeft size={17} /> : <ArrowUpRight size={17} />}
                    </div>
                    <div>
                      <strong>{t.description}</strong>
                      <small>
                        {t.status === 'pending' ? 'Pending · excluded from actuals' : t.kind || 'expense'}
                        {t.reviewReason ? ' · Needs review' : ''}
                      </small>
                      <div className="tag-list">
                        {(t.tags || []).map((tag) => (
                          <span className="category-tag" key={tag}>
                            {tag}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                </td>
                <td>{String(t.date || '').slice(0, 10)}</td>
                <td>
                  <span className="category-tag">
                    {t.splits?.length > 1
                      ? 'Split transaction'
                      : t.categoryDisplayLabel || t.category || 'Uncategorized'}
                  </span>
                  {t.categoryDisplayLabel === 'Unresolved category' && (
                    <small>Category name unavailable; saved references need a category choice.</small>
                  )}
                </td>
                <td className="muted">{t.accountName || '—'}</td>
                <td className={`align-right amount ${BigInt(t.amountMinor || 0) > 0n ? 'positive' : ''}`}>
                  {money(t.amountMinor, t.currency)}
                </td>
                <td>
                  {isAdmin && (
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Create rule from ${t.description}`}
                      onClick={() => onCreateRule(t)}
                    >
                      Create rule
                    </Button>
                  )}
                  {(t.canEdit || canEditAccount(t.accountId)) && (
                    <Button size="sm" variant="ghost" aria-label={`Edit ${t.description}`} onClick={() => onEdit(t)}>
                      Edit
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {ids !== null && (
        <div className="table-footer">
          Showing transactions contributing to the selected total.{' '}
          <button
            onClick={() => {
              onFiltersChange({ ids: null, category: '', tag: '', kind: '', status: '' });
            }}
          >
            Clear drilldown
          </button>
        </div>
      )}
      {!transactions.length && (
        <Empty title="No transactions here yet" detail="Try another month or adjust your filters." />
      )}
      <div className="table-footer">
        <span>
          {data.total ?? transactions.length} transactions · {currency} · Posted actuals use transaction date
        </span>
        <div className="pagination">
          <Button
            variant="outline"
            size="sm"
            disabled={txPage <= 1}
            onClick={() => onFiltersChange({ txPage: txPage - 1 })}
          >
            Previous
          </Button>
          <span>Page {txPage}</span>
          <Button
            variant="outline"
            size="sm"
            disabled={
              data.hasMore === false || (data.total != null ? txPage * 50 >= data.total : transactions.length < 50)
            }
            onClick={() => onFiltersChange({ txPage: txPage + 1 })}
          >
            Next
          </Button>
        </div>
      </div>
    </section>
  );
}
