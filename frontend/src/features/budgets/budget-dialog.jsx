import { useState, useEffect } from 'react';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { minorToDecimal } from '../../money.js';
import { budgetValues } from './budget-model.js';

export function BudgetDialog({ budget, close, busy, save, serverError, currency, canChangeCategory }) {
  const [category, setCategory] = useState(''),
    [categoryEdited, setCategoryEdited] = useState(false),
    [cap, setCap] = useState(''),
    [allocation, setAllocation] = useState('0.00'),
    [rollover, setRollover] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    if (budget) {
      setCategory(budget.category);
      setCategoryEdited(false);
      setCap(minorToDecimal(budget.capMinor, currency));
      setAllocation(minorToDecimal(budget.allocationMinor, currency));
      setRollover(!!budget.rolloverEnabled);
      setError('');
    }
  }, [budget, currency]);
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
          <input
            required
            disabled={!canChangeCategory}
            value={!categoryEdited && budget?.categoryDisplayLabel ? budget.categoryDisplayLabel : category}
            onChange={(e) => {
              setCategory(e.target.value);
              setCategoryEdited(true);
            }}
          />
        </label>
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
