import { useDraftGuard } from '../../hooks/use-draft-guard.mjs';
import { useState, useEffect } from 'react';
import { Sparkles, Plus, X } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { api } from '../../lib/api.mjs';
import { CategorySelect } from '../../components/category-select';
import { TransactionTags } from '../../components/transaction-tags';
import { useCategoryOptions } from '../../hooks/use-category-options.mjs';
import { money, minorToDecimal } from '../../money.mjs';
import { transactionCorrection } from './transaction-model.mjs';
import { kindLabel } from '../../lib/labels.mjs';

export function EditTransaction({ canSuggest, transaction, open, close, busy, save, serverError, onDirtyChange }) {
  const options = useCategoryOptions(transaction?.id);
  const [tagDraft, setTagDraft] = useState('');
  const [tags, setTags] = useState([]);
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
      setTags(transaction.tags || []);
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
  const initialSplits = (transaction?.splits || []).map((s) => ({
    ...s,
    categoryEdited: false,
    amount: minorToDecimal(s.amountMinor, transaction.currency)
  }));
  useDraftGuard(
    onDirtyChange,
    'transaction',
    !!transaction &&
      (busy ||
        suggesting ||
        !!tagDraft ||
        categoryEdited ||
        kind !== (transaction.kind || 'expense') ||
        JSON.stringify(tags) !== JSON.stringify(transaction.tags || []) ||
        JSON.stringify(splits) !== JSON.stringify(initialSplits))
  );
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => !v && close()}
      title="Edit transaction"
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
              { category, categoryEdited, preserveUntouched: true, kind, splits, tags },
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
          <CategorySelect
            catalog={options.catalog}
            value={category}
            label={transaction?.categoryDisplayLabel}
            onChange={(e) => {
              setCategory(e.target.value);
              setCategoryEdited(true);
            }}
            required
          />
        </label>
        {options.error && (
          <p role="alert" className="negative">
            Categories could not be loaded: {options.error}
          </p>
        )}
        {!categoryEdited && transaction?.categoryDisplayLabel === 'Unresolved category' && (
          <p className="footnote">
            Choose a category to resolve this reference. Leaving it unchanged preserves its saved category.
          </p>
        )}
        {(canSuggest || !transaction?.internalTransfer) && (
          <TransactionTags
            key={transaction?.id}
            tags={tags}
            onChange={setTags}
            suggestions={options.tags}
            onDraftChange={setTagDraft}
          />
        )}
        <label>
          Transaction type
          <select
            disabled={!canSuggest && transaction?.internalTransfer}
            value={kind}
            onChange={(e) => setKind(e.target.value)}
          >
            {['expense', 'income', 'transfer', 'refund'].map((k) => (
              <option key={k} value={k}>
                {kindLabel(k)}
              </option>
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
              <Sparkles size={16} />
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
            variant="outline"
            onClick={() =>
              setSplits([
                ...splits,
                {
                  category:
                    options.catalog.find((entry) => !entry.archived && entry.category === 'Other')?.category ||
                    'Uncategorized',
                  amount: splits.length
                    ? minorToDecimal('0', transaction.currency)
                    : minorToDecimal(transaction.amountMinor, transaction.currency)
                }
              ])
            }
          >
            <Plus size={16} />
            Add split
          </Button>
        </div>
        {splits.map((s, i) => (
          <div className="split-row" key={i}>
            <CategorySelect
              aria-label={`Split ${i + 1} category`}
              catalog={options.catalog}
              required
              label={s.categoryDisplayLabel}
              value={s.category}
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
