import { useState } from 'react';
import { AlertCircle, Check } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Empty } from '../../components/empty-state';
import { money } from '../../money.mjs';

const identityReview = (reason) => /(replacement|identity)/i.test(reason || '');
const actionLabel = (reason) =>
  identityReview(reason)
    ? 'Keep separate'
    : /^(Category needs review|Classification review:)/i.test(reason || '')
      ? 'Accept current classification'
      : 'Dismiss warning';

export function ReviewsPage({ reviews, busy, onEdit, mutate, canEditAccount, isAdmin, onCreateRule }) {
  return (
    <section className="card">
      {reviews.length ? (
        reviews.map((r) => (
          <div className="review-row" key={r.id}>
            <div className="review-icon">
              <AlertCircle size={21} />
            </div>
            <div>
              <h2>{r.description || r.title || 'Transaction needs review'}</h2>
              <p>
                <strong className="amount">
                  {money(r.amountMinor ?? null, r.currency)}
                  {r.currency ? ` ${r.currency}` : ''}
                </strong>
                {r.date ? ` · ${String(r.date).slice(0, 10)}` : ''}
                {r.accountName ? ` · ${r.accountName}` : ''}
              </p>
              <p>
                {r.categoryDisplayLabel || r.category || 'Uncategorized'}
                {r.kind ? ` · Current type: ${r.kind}` : ''}
              </p>
              <p>{r.reviewReason || r.reason || r.type || 'Check the original evidence before resolving this item.'}</p>
              {r.categoryDisplayLabel === 'Unresolved category' && (
                <p className="footnote">Category name unavailable; saved references need a category choice.</p>
              )}
              <p className="footnote">
                {identityReview(r.reviewReason)
                  ? 'Keep separate clears this warning without linking records. Pending entries stay separate from posted actuals.'
                  : `${actionLabel(r.reviewReason)} clears this warning without changing the category, type or amount.`}{' '}
                New evidence or later classification checks may request review again.
                {r.kind === 'transfer' &&
                  ' This is currently a transfer, so it is excluded from income and spending totals. Use Review details to correct the type if needed.'}
              </p>
              <small>Transaction: {r.id}</small>
            </div>
            <div className="review-actions">
              {isAdmin && (
                <Button
                  variant="outline"
                  disabled={busy}
                  aria-label={`Create rule from ${r.description}`}
                  onClick={() => onCreateRule(r)}
                >
                  Create rule
                </Button>
              )}
              <Button
                variant="outline"
                disabled={busy || !(r.canEdit || canEditAccount?.(r.accountId))}
                onClick={() => onEdit(r)}
              >
                Review details
              </Button>
              {identityReview(r.reviewReason) && r.status === 'posted' && (
                <ReviewLink
                  busy={busy || !(r.canEdit || canEditAccount?.(r.accountId))}
                  onLink={(pendingId) =>
                    mutate(`/reviews/${r.id}`, {
                      action: 'link',
                      pendingId
                    })
                  }
                />
              )}
              <Button
                variant="ghost"
                disabled={busy || !(r.canEdit || canEditAccount?.(r.accountId))}
                onClick={() => mutate(`/reviews/${r.id}`, { action: 'keep' })}
              >
                {actionLabel(r.reviewReason)}
              </Button>
            </div>
          </div>
        ))
      ) : (
        <Empty
          title="All clear for now"
          detail="Ambiguous pending matches and uncertain classifications will appear here."
          icon={Check}
        />
      )}
    </section>
  );
}

function ReviewLink({ busy, onLink }) {
  const [pendingId, setPendingId] = useState('');
  return (
    <form
      className="review-link"
      onSubmit={(e) => {
        e.preventDefault();
        if (pendingId.trim()) {
          onLink(pendingId.trim());
        }
      }}
    >
      <input
        aria-label="Pending transaction ID"
        placeholder="Pending transaction ID"
        value={pendingId}
        onChange={(e) => setPendingId(e.target.value)}
        required
      />
      <Button variant="outline" disabled={busy || !pendingId.trim()}>
        Link pending
      </Button>
    </form>
  );
}
