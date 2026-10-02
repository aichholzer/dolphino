import { useState, useEffect } from 'react';
import { Sparkles, Plus, X } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { api } from '../../lib/api.mjs';
import { CATEGORIES } from './categories.mjs';
import { money, minorToDecimal } from '../../money.mjs';
import { transactionCorrection } from './transaction-model.mjs';

export function EditTransaction({ canSuggest, transaction, open, close, busy, save, serverError }) {
  const [llmEnabled, setLlmEnabled] = useState(false),
    [suggesting, setSuggesting] = useState(false),
    [suggestion, setSuggestion] = useState(null);
  useEffect(() => {
    if (!canSuggest) {
      setLlmEnabled(false);
      setSuggestion(null);
      return;
    }

    if (transaction) {
      setSuggestion(null);
      api('/settings')
        .then((s) => setLlmEnabled(!!s.llm?.enabled))
        .catch(() => setLlmEnabled(false));
    }
  }, [transaction, canSuggest]);
  const [category, setCategory] = useState(''),
    [categoryEdited, setCategoryEdited] = useState(false),
    [kind, setKind] = useState('expense'),
    [splits, setSplits] = useState([]),
    [error, setError] = useState('');
  useEffect(() => {
    if (transaction) {
      setCategory(transaction.category || 'Uncategorized');
      setCategoryEdited(false);
      setKind(transaction.kind || 'expense');
      setSplits(
        (transaction.splits || []).map((s) => ({
          ...s,
          categoryEdited: false,
          amount: minorToDecimal(s.amountMinor, transaction.currency)
        }))
      );
      setError('');
    }
  }, [transaction]);
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => !v && close()}
      title="Make it your own"
      description={
        transaction
          ? `${transaction.description} · ${money(transaction.amountMinor ?? null, transaction.currency)}`
          : ''
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          try {
            const values = transactionCorrection(
              { category, categoryEdited, preserveUntouched: true, kind, splits },
              transaction
            );
            setError('');
            save(values);
          } catch (e) {
            setError(e.message);
          }
        }}
      >
        <label>
          Category
          <input
            list="category-options"
            value={!categoryEdited && transaction?.categoryDisplayLabel ? transaction.categoryDisplayLabel : category}
            onChange={(e) => {
              setCategory(e.target.value);
              setCategoryEdited(true);
            }}
            required
          />
        </label>
        {!categoryEdited && transaction?.categoryDisplayLabel && (
          <p className="footnote">
            Choose a category to resolve this reference. Leaving it unchanged preserves its saved category.
          </p>
        )}
        <datalist id="category-options">
          {CATEGORIES.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
        <label>
          Transaction type
          <select
            disabled={!canSuggest && transaction?.internalTransfer}
            value={kind}
            onChange={(e) => setKind(e.target.value)}
          >
            {['expense', 'income', 'transfer', 'refund'].map((k) => (
              <option key={k}>{k}</option>
            ))}
          </select>
        </label>
        {canSuggest && llmEnabled && (
          <div className="ai-suggestion">
            <Button
              type="button"
              variant="outline"
              disabled={suggesting}
              onClick={async () => {
                setSuggesting(true);
                try {
                  setSuggestion(
                    await api(`/transactions/${transaction.id}/suggest`, {
                      method: 'POST',
                      body: '{}'
                    })
                  );
                } catch (e) {
                  setError(e.message);
                } finally {
                  setSuggesting(false);
                }
              }}
            >
              <Sparkles size={14} />
              {suggesting ? 'Getting suggestion…' : 'Suggest category with AI'}
            </Button>
            {suggestion && (
              <p className="footnote">
                Suggestion: {suggestion.category}. {suggestion.reason}{' '}
                <button
                  type="button"
                  onClick={() => {
                    setCategory(suggestion.category);
                    setCategoryEdited(true);
                  }}
                >
                  Use this category
                </button>{' '}
                · Review before saving.
              </p>
            )}
          </div>
        )}
        <div className="split-heading">
          <strong>Split categories</strong>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() =>
              setSplits([
                ...splits,
                {
                  category: 'Other',
                  amount: splits.length
                    ? minorToDecimal('0', transaction.currency)
                    : minorToDecimal(transaction.amountMinor, transaction.currency)
                }
              ])
            }
          >
            <Plus size={14} />
            Add split
          </Button>
        </div>
        {splits.map((s, i) => (
          <div className="split-row" key={i}>
            <input
              aria-label={`Split ${i + 1} category`}
              list="category-options"
              value={!s.categoryEdited && s.categoryDisplayLabel ? s.categoryDisplayLabel : s.category}
              onChange={(e) =>
                setSplits(
                  splits.map((x, j) => (j === i ? { ...x, category: e.target.value, categoryEdited: true } : x))
                )
              }
            />
            <input
              aria-label={`Split ${i + 1} amount`}
              inputMode="decimal"
              value={s.amount}
              onChange={(e) => setSplits(splits.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={`Remove split ${i + 1}`}
              onClick={() => setSplits(splits.filter((_, j) => j !== i))}
            >
              <X size={16} />
            </Button>
          </div>
        ))}
        <p className="footnote">
          Use signed amounts (negative for expenses). Your corrections are retained when provider records update.
        </p>
        {error && (
          <p role="alert" className="negative">
            {error}
          </p>
        )}
        {serverError && (
          <p role="alert" className="negative">
            {serverError}
          </p>
        )}
        <div className="dialog-actions">
          <Button type="button" variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button disabled={busy}>Save correction</Button>
        </div>
      </form>
    </Dialog>
  );
}
