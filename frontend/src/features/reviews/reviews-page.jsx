import { useState } from 'react';
import { AlertCircle, Check } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Empty } from '../../components/empty-state';
import { money } from '../../money.js';

export function ReviewsPage({ reviews, busy, onEdit, mutate }) {
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
              {r.categoryDisplayLabel && (
                <p className="footnote">Category name unavailable; saved references need a category choice.</p>
              )}
              <small>Transaction: {r.id}</small>
            </div>
            <div className="review-actions">
              <Button variant="outline" disabled={busy} onClick={() => onEdit(r)}>
                Review details
              </Button>
              <ReviewLink
                busy={busy}
                onLink={(pendingId) =>
                  mutate(`/reviews/${r.id}`, {
                    action: 'link',
                    pendingId
                  })
                }
              />
              <Button variant="ghost" disabled={busy} onClick={() => mutate(`/reviews/${r.id}`, { action: 'keep' })}>
                Keep separate
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
