import { useEffect, useRef, useState } from 'react';
import { AlertCircle, Check } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Empty } from '../../components/empty-state';
import { api } from '../../lib/api.mjs';
import { money } from '../../money.mjs';
import { kindLabel } from '../../lib/labels.mjs';

const identityReview = (reason) => /(replacement|identity)/i.test(reason || '');
const categoryReview = (reason) => reason === 'Category needs review';
const actionLabel = (reason) =>
  identityReview(reason)
    ? 'Keep separate'
    : /^(Category needs review|Classification review:)/i.test(reason || '')
      ? 'Accept classification'
      : 'Dismiss warning';

function categoryFact(r) {
  const name = r.categoryDisplayLabel || r.category || 'Uncategorized';
  if (!categoryReview(r.reviewReason)) {
    return name;
  }

  return name === 'Uncategorized' ? 'Needs review' : `${name}, needs review`;
}

// A category review is already stated on the Category line; other reasons read without their prefix.
function reasonFact(r) {
  const reason = r.reviewReason || r.reason || r.type;
  if (categoryReview(reason)) {
    return '';
  }

  if (!reason) {
    return 'Check the original evidence before resolving this item.';
  }

  const text = reason.replace(/^Classification review:\s*/i, '');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function ReviewsPage({ reviews, busy, onEdit, canEditAccount, isAdmin, onCreateRule, onRefresh, onNotice }) {
  const editable = (r) => !!(r.canEdit || canEditAccount?.(r.accountId));
  const [selected, setSelected] = useState(() => new Set());
  const [progress, setProgress] = useState(null);
  const [bulkError, setBulkError] = useState('');
  const rows = useRef([]);
  const emptyState = useRef(null);
  const focusAfter = useRef(null);
  const alive = useRef(true);
  const working = busy || !!progress;
  const resolvable = reviews.filter(editable);
  const chosen = resolvable.filter((r) => selected.has(r.id));

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // A refreshed queue drops resolved items from the selection and puts focus back where the reader was.
  useEffect(() => {
    setSelected((old) => {
      const ids = new Set(reviews.map((r) => r.id));
      const next = new Set([...old].filter((id) => ids.has(id)));
      return next.size === old.size ? old : next;
    });
    if (focusAfter.current !== null) {
      const index = Math.min(focusAfter.current, reviews.length - 1);
      focusAfter.current = null;
      (index >= 0 ? rows.current[index] : emptyState.current)?.focus();
    }
  }, [reviews]);

  function toggle(id) {
    setSelected((old) => {
      const next = new Set(old);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }

      return next;
    });
  }

  // One request per item keeps the audit trail per transaction. The queue refreshes in the background
  // and focus stays on the list; failures stay selected and are named for a retry.
  async function run(items, body, nextFocus) {
    const failures = [];
    setBulkError('');
    for (const [i, review] of items.entries()) {
      if (alive.current) {
        setProgress({ done: i, total: items.length });
      }

      try {
        await api(`/reviews/${review.id}`, { method: 'POST', body: JSON.stringify(body(review)) });
      } catch (error) {
        failures.push({ review, message: error.message });
      }
    }

    if (alive.current) {
      focusAfter.current = nextFocus;
      setSelected((old) => {
        const next = new Set([...old].filter((id) => !items.some((r) => r.id === id)));
        failures.forEach((f) => next.add(f.review.id));
        return next;
      });
    }

    // A batch that outlives this page still refreshes whichever report is current.
    await onRefresh?.();
    if (!alive.current) {
      return !failures.length;
    }

    setProgress(null);
    const resolved = items.length - failures.length;
    if (failures.length) {
      setBulkError(
        `${items.length > 1 ? `Resolved ${resolved} of ${items.length}. ` : ''}Still open: ${failures
          .map((f) => `${f.review.description || 'Transaction'} (${f.message})`)
          .join('; ')}.`
      );
    } else {
      onNotice?.(`Resolved ${plural(resolved, 'item')}.`);
    }

    return !failures.length;
  }

  const resolve = (review, index) => run([review], () => ({ action: 'keep' }), index);
  const resolveSelected = () => run(chosen, () => ({ action: 'keep' }), 0);
  const link = (review, index, pendingId) => run([review], () => ({ action: 'link', pendingId }), index);

  function keys(event, review, index) {
    if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey) {
      return;
    }

    const move = (to) => rows.current[Math.max(0, Math.min(reviews.length - 1, to))]?.focus();
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    const actions = {
      ArrowDown: () => move(index + 1),
      j: () => move(index + 1),
      ArrowUp: () => move(index - 1),
      k: () => move(index - 1),
      Home: () => move(0),
      End: () => move(reviews.length - 1),
      x: () => editable(review) && toggle(review.id),
      ' ': () => editable(review) && toggle(review.id),
      a: () => editable(review) && !working && resolve(review, index),
      Enter: () => editable(review) && onEdit(review)
    };
    if (actions[key]) {
      event.preventDefault();
      actions[key]();
    }
  }

  if (!reviews.length) {
    return (
      <section className="card review-queue" ref={emptyState} tabIndex={-1} aria-label="Review queue">
        <Empty
          title="All clear for now"
          detail="Ambiguous pending matches and uncertain classifications will appear here."
          icon={Check}
        />
      </section>
    );
  }

  return (
    <section className="card review-queue" aria-label="Review queue">
      <div className="review-toolbar">
        <label className="checkbox-label">
          <input
            type="checkbox"
            disabled={working || !resolvable.length}
            checked={!!resolvable.length && chosen.length === resolvable.length}
            ref={(el) => el && (el.indeterminate = chosen.length > 0 && chosen.length < resolvable.length)}
            onChange={(e) => setSelected(e.target.checked ? new Set(resolvable.map((r) => r.id)) : new Set())}
          />
          Select all
        </label>
        <span className="muted" aria-live="polite">
          {progress
            ? `Resolving ${progress.done + 1} of ${progress.total}…`
            : chosen.length
              ? `${chosen.length} selected`
              : plural(reviews.length, 'item')}
        </span>
        <Button className="review-bulk" disabled={working || !chosen.length} onClick={resolveSelected}>
          {chosen.length ? `Resolve ${plural(chosen.length, 'item')}` : 'Resolve selected'}
        </Button>
        <div className="review-note">
          <p>
            Accepting a classification removes the transaction from this screen without changes.
            <br />
            New evidence or additional classifications may request a new review.
          </p>
          {reviews.some((r) => identityReview(r.reviewReason)) && (
            <p>Keep separate clears a replacement warning without linking the records.</p>
          )}
          <p className="review-keys">
            <kbd>↑</kbd> <kbd>↓</kbd> or <kbd>J</kbd> <kbd>K</kbd> to move, <kbd>A</kbd> to resolve, <kbd>X</kbd> to
            select, <kbd>Enter</kbd> for details.
          </p>
        </div>
      </div>
      {bulkError && (
        <div role="alert" className="alert alert-error review-bulk-error">
          <AlertCircle size={18} />
          <span>{bulkError}</span>
        </div>
      )}
      {reviews.map((r, index) => (
        <div
          className={`review-row ${selected.has(r.id) ? 'selected' : ''}`}
          key={r.id}
          ref={(el) => {
            rows.current[index] = el;
          }}
          tabIndex={0}
          role="group"
          aria-label={r.description || 'Transaction needs review'}
          aria-keyshortcuts="ArrowUp ArrowDown J K A X Enter"
          onKeyDown={(e) => keys(e, r, index)}
        >
          <input
            type="checkbox"
            className="review-select"
            aria-label={`Select ${r.description || 'transaction'}`}
            title={editable(r) ? undefined : 'View only: resolving needs edit access to this account'}
            disabled={working || !editable(r)}
            checked={selected.has(r.id)}
            onChange={() => toggle(r.id)}
          />
          <div className="review-icon">
            <AlertCircle size={21} />
          </div>
          <div className="review-body">
            <h2>{r.description || r.title || 'Transaction needs review'}</h2>
            <p>
              <strong className="amount">
                {money(r.amountMinor ?? null, r.currency)}
                {r.currency ? ` ${r.currency}` : ''}
              </strong>
              {r.date ? ` · ${String(r.date).slice(0, 10)}` : ''}
              {r.accountName ? ` · ${r.accountName}` : ''}
            </p>
            <dl className="review-facts">
              {r.kind && (
                <div>
                  <dt>Type</dt>
                  <dd>
                    {kindLabel(r.kind)}
                    {r.kind === 'transfer' && ', excluded from income and spending totals'}
                  </dd>
                </div>
              )}
              <div>
                <dt>Category</dt>
                <dd>{categoryFact(r)}</dd>
              </div>
              {reasonFact(r) && (
                <div>
                  <dt>Reason</dt>
                  <dd>{reasonFact(r)}</dd>
                </div>
              )}
              <div>
                <dt>Transaction</dt>
                <dd>{r.id}</dd>
              </div>
            </dl>
            {!editable(r) && (
              <p className="footnote">
                View only: resolving this item needs edit access to {r.accountName || 'its account'}.
              </p>
            )}
          </div>
          <div className="review-actions">
            <Button variant="outline" disabled={working || !editable(r)} onClick={() => resolve(r, index)}>
              {actionLabel(r.reviewReason)}
            </Button>
            <Button variant="outline" disabled={working || !editable(r)} onClick={() => onEdit(r)}>
              Review details
            </Button>
            {identityReview(r.reviewReason) && r.status === 'posted' && (
              <PendingMatch
                review={r}
                busy={working || !editable(r)}
                onLink={(pendingId) => link(r, index, pendingId)}
              />
            )}
            {isAdmin && (
              <Button
                variant="outline"
                disabled={working}
                aria-label={`Create rule from ${r.description}`}
                onClick={() => onCreateRule(r)}
              >
                Create rule
              </Button>
            )}
          </div>
        </div>
      ))}
    </section>
  );
}

const day = (value) => Date.parse(String(value || '').slice(0, 10)) || 0;
const distance = (a, b) => {
  const diff = BigInt(a.amountMinor || 0) - BigInt(b.amountMinor || 0);
  return diff < 0n ? -diff : diff;
};

// Only a pending item in the same account and currency can be linked; the closest amount and date come first.
function PendingMatch({ review, busy, onLink }) {
  const [state, setState] = useState({ status: 'loading', candidates: [] });
  const [choice, setChoice] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setState({ status: 'loading', candidates: [] });
    const query = new URLSearchParams({
      status: 'pending',
      allHistory: 'true',
      accountId: review.accountId || '',
      currency: review.currency || '',
      page: '1',
      pageSize: '50'
    });
    api(`/transactions?${query}`)
      .then((result) => {
        if (!live) {
          return;
        }

        const candidates = (result.transactions || [])
          .filter((t) => t.id !== review.id && t.status === 'pending' && !t.supersededBy && !t.voided)
          .filter((t) => t.accountId === review.accountId && t.currency === review.currency)
          .sort(
            (a, b) =>
              (distance(a, review) < distance(b, review) ? -1 : distance(a, review) > distance(b, review) ? 1 : 0) ||
              Math.abs(day(a.date) - day(review.date)) - Math.abs(day(b.date) - day(review.date))
          );
        setState({ status: 'ready', candidates });
        const exact = candidates.find((t) => distance(t, review) === 0n);
        setChoice((old) => old || exact?.id || '');
      })
      .catch((error) => live && setState({ status: 'error', candidates: [], message: error.message }));
    return () => {
      live = false;
    };
  }, [review.id, review.accountId, review.currency, review.amountMinor, review.date, attempt]);

  const { status, candidates } = state;
  return (
    <form
      className="review-link"
      onSubmit={(e) => {
        e.preventDefault();
        if (choice) {
          onLink(choice);
        }
      }}
    >
      <select
        aria-label="Pending match"
        value={choice}
        disabled={busy || status !== 'ready' || !candidates.length}
        onChange={(e) => setChoice(e.target.value)}
      >
        {status === 'loading' && <option value="">Finding pending matches…</option>}
        {status === 'error' && <option value="">Pending matches unavailable</option>}
        {status === 'ready' && !candidates.length && <option value="">No pending items in this account</option>}
        {status === 'ready' && candidates.length > 0 && <option value="">Choose a pending match</option>}
        {candidates.map((t) => (
          <option key={t.id} value={t.id}>
            {String(t.date).slice(0, 10)} · {t.description || 'Pending transaction'} ·{' '}
            {money(t.amountMinor, t.currency)}
          </option>
        ))}
      </select>
      <Button variant="outline" disabled={busy || !choice}>
        Link pending
      </Button>
      {status === 'error' && (
        <p role="alert" className="negative review-link-error">
          {state.message || 'Pending matches could not be loaded.'}{' '}
          <Button type="button" variant="outline" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </Button>
        </p>
      )}
    </form>
  );
}
