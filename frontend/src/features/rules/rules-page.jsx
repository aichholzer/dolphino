import { useState, useEffect } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { Empty } from '../../components/empty-state';

export function RulesPage({ rules, onEdit }) {
  return (
    <>
      <div className="section-toolbar">
        <p>Rules run before optional AI classification.</p>
        <Button
          onClick={() =>
            onEdit({
              match: '',
              category: 'Groceries',
              kind: 'expense'
            })
          }
        >
          <Plus size={16} />
          Add rule
        </Button>
      </div>
      <section className="card">
        {rules.map((r, i) => (
          <div className="rule-row" key={r.id || i}>
            <div className="rule-number">{i + 1}</div>
            <div>
              <h2>Description contains “{r.match || r.pattern}”</h2>
              <p>
                Classify as {r.category} · {r.kind || 'expense'}
              </p>
            </div>
            <span className="category-tag">Active</span>
          </div>
        ))}
        {!rules.length && (
          <Empty
            title="Put the familiar on autopilot"
            detail="Create a rule for a merchant or description. Your manual corrections always take priority."
          />
        )}
      </section>
    </>
  );
}

export function RuleDialog({ rule, close, busy, save, serverError }) {
  const [values, setValues] = useState({});
  useEffect(() => {
    setValues(rule || {});
  }, [rule]);
  return (
    <Dialog
      open={!!rule}
      onOpenChange={(v) => !v && close()}
      title="Create a classification rule"
      description="Matches transaction descriptions, ignoring letter case."
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save(values);
        }}
      >
        <label>
          Description contains
          <input
            required
            placeholder="e.g. Woolworths"
            value={values.match || ''}
            onChange={(e) => setValues({ ...values, match: e.target.value })}
          />
        </label>
        <label>
          Assign category
          <input
            required
            value={values.category || ''}
            onChange={(e) => setValues({ ...values, category: e.target.value })}
          />
        </label>
        <label>
          Transaction type
          <select value={values.kind || 'expense'} onChange={(e) => setValues({ ...values, kind: e.target.value })}>
            {['expense', 'income', 'transfer', 'refund'].map((k) => (
              <option key={k}>{k}</option>
            ))}
          </select>
        </label>
        {serverError && (
          <p role="alert" className="negative">
            {serverError}
          </p>
        )}
        <div className="dialog-actions">
          <Button type="button" variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button disabled={busy}>Create rule</Button>
        </div>
      </form>
    </Dialog>
  );
}
