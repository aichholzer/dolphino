import { useDraftGuard } from '../../hooks/use-draft-guard.mjs';
import { useState, useEffect } from 'react';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { minorToDecimal } from '../../money.mjs';
import { CategorySelect } from '../../components/category-select';
import { useCategoryOptions } from '../../hooks/use-category-options.mjs';
import { budgetValues } from './budget-model.mjs';

export function BudgetDialog({ budget, close, busy, save, serverError, currency, canChangeCategory, onDirtyChange }) {
  const options = useCategoryOptions(!!budget);
  const [category, setCategory] = useState(''),
    [cap, setCap] = useState(''),
    [allocation, setAllocation] = useState('0.00'),
    [rollover, setRollover] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    if (budget) {
      setCategory(budget.category);
      setCap(minorToDecimal(budget.capMinor, currency));
      setAllocation(minorToDecimal(budget.allocationMinor, currency));
      setRollover(!!budget.rolloverEnabled);
      setError('');
    }
  }, [budget, currency]);
  useDraftGuard(
    onDirtyChange,
    'budget',
    !!budget &&
      (busy ||
        category !== budget.category ||
        cap !== minorToDecimal(budget.capMinor, currency) ||
        allocation !== minorToDecimal(budget.allocationMinor, currency) ||
        rollover !== !!budget.rolloverEnabled)
  );
  return (
    <Dialog
      open={!!budget}
      onOpenChange={(v) => !v && close()}
      title="Make a little plan"
      description="Set a monthly category spending cap."
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          try {
            save(budgetValues({ category, cap, allocation, rollover }, currency));
          } catch (e) {
            setError(e.message);
          }
        }}
      >
        <label>
          Category
          <CategorySelect
            catalog={options.catalog}
            required
            disabled={!canChangeCategory || !!budget?.id}
            label={budget?.categoryDisplayLabel}
            value={category}
            onChange={(e) => {
              setCategory(e.target.value);
            }}
          />
        </label>
        {budget?.id && canChangeCategory && (
          <p className="footnote">Rename this category for all transactions and budgets in Settings → Categories.</p>
        )}
        {options.error && (
          <p role="alert" className="negative">
            Categories could not be loaded: {options.error}
          </p>
        )}
        <label>
          Monthly cap
          <input required inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value)} />
        </label>
        <label>
          Additional allocation
          <input inputMode="decimal" required value={allocation} onChange={(e) => setAllocation(e.target.value)} />
        </label>
        <p className="footnote">An allocation adds to this category’s allowance. It does not create a bank expense.</p>
        <label className="checkbox-label">
          <input type="checkbox" checked={rollover} onChange={(e) => setRollover(e.target.checked)} />
          Roll unused funds into the next month
        </label>
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
          <Button disabled={busy}>Save budget</Button>
        </div>
      </form>
    </Dialog>
  );
}
