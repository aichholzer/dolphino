import { useState, useEffect, useRef } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Dialog } from '../../components/ui/dialog';
import { Empty } from '../../components/empty-state';
import { CategorySelect } from '../../components/category-select';
import { TransactionTags } from '../../components/transaction-tags';
import { useCategoryOptions } from '../../hooks/use-category-options.mjs';
import { useDraftGuard } from '../../hooks/use-draft-guard.mjs';
import { api } from '../../lib/api.mjs';

import { ruleValues } from './rule-model.mjs';

export function RulesPage({ rules, onEdit, busy, onDelete }) {
  return (
    <>
      <div className="section-toolbar">
        <p>First matching rule wins. Manual corrections take priority; rule tags are additive.</p>
        <Button onClick={() => onEdit({ match: '', category: '', kind: 'expense', tags: [] })}>
          <Plus size={16} />
          Add rule
        </Button>
      </div>
      <section className="card">
        {rules.map((rule, index) => (
          <div className="rule-row" key={rule.id}>
            <div className="rule-number">{index + 1}</div>
            <div>
              <h2>Description contains “{rule.match}”</h2>
              <p>
                Classify as {rule.categoryDisplayLabel || rule.category} · {rule.kind || 'imported type'} · Priority{' '}
                {rule.priority}
              </p>
              <div className="tag-list">
                {rule.tags?.map((tag) => (
                  <span className="category-tag" key={tag}>
                    {tag}
                  </span>
                ))}
              </div>
            </div>
            <div className="rule-actions">
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                aria-label={`Edit rule ${rule.match}`}
                onClick={() => onEdit(rule)}
              >
                Edit
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                aria-label={`Delete rule ${rule.match}`}
                onClick={() => onDelete(rule.id)}
              >
                Delete
              </Button>
            </div>
          </div>
        ))}
        {!rules.length && (
          <Empty
            title="Put the familiar on autopilot"
            detail="Create a rule for a merchant or description. Your manual corrections always take priority."
          />
        )}
      </section>
      <p className="footnote">
        Changing or deleting a rule leaves previously added tags in place. Tags you remove from a transaction stay
        removed until you explicitly add them again.
      </p>
    </>
  );
}

export function RuleDialog({ rule, close, busy, save, serverError, onDirtyChange }) {
  const [values, setValues] = useState(() => ruleValues(rule));
  const [preview, setPreview] = useState(null);
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState('');
  const [tagDraft, setTagDraft] = useState('');
  const generation = useRef(0);
  const saving = useRef(false);
  const options = useCategoryOptions(rule);
  const fingerprint = JSON.stringify(values);
  useEffect(() => {
    setValues(ruleValues(rule));
    setPreview(null);
    setError('');
    setPreviewing(false);
    setTagDraft('');
    generation.current++;
    return () => {
      generation.current++;
    };
  }, [rule]);
  useDraftGuard(
    onDirtyChange,
    'rule',
    !!rule && (busy || previewing || !!tagDraft || fingerprint !== JSON.stringify(ruleValues(rule)))
  );
  const selected = options.catalog.find((entry) => entry.category === values.category);
  const categoryAllowed = (!!selected && !selected.archived) || (!!rule?.id && rule.category === values.category);
  const canPreview = !!values.match.trim() && categoryAllowed && !options.loading && !options.error && !tagDraft.trim();
  const currentPreview = preview?.fingerprint === fingerprint;
  async function previewMatches() {
    const request = ++generation.current;
    setPreviewing(true);
    setError('');
    try {
      const result = await api('/rules/preview', { method: 'POST', body: fingerprint });
      if (request === generation.current) {
        setPreview({ ...result, fingerprint });
      }
    } catch (error) {
      if (request === generation.current) {
        setError(error.message);
      }
    } finally {
      if (request === generation.current) {
        setPreviewing(false);
      }
    }
  }

  return (
    <Dialog
      open={!!rule}
      onOpenChange={(open) => !open && close()}
      title={rule?.id ? 'Edit classification rule' : 'Create a classification rule'}
      description={
        rule?.sourceDescription
          ? `Start from “${rule.sourceDescription}”. Review the match and preview before saving.`
          : 'Matches transaction descriptions, ignoring letter case. Preview before applying to history and future imports.'
      }
    >
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (currentPreview && canPreview && !previewing && !busy && !saving.current) {
            saving.current = true;
            try {
              await save(values);
            } finally {
              saving.current = false;
            }
          }
        }}
      >
        {rule?.sourceDescription?.length > 200 && (
          <p className="footnote">
            This description exceeds 200 characters. Enter the exact text you want to match, then preview its scope.
          </p>
        )}
        <label>
          Description contains
          <input
            required
            maxLength={200}
            placeholder="e.g. Woolworths"
            value={values.match}
            onChange={(event) => setValues({ ...values, match: event.target.value })}
          />
        </label>
        <label>
          Assign category
          <CategorySelect
            aria-label="Assign category"
            catalog={options.catalog}
            value={values.category}
            label={rule?.categoryDisplayLabel}
            required
            onChange={(event) => setValues({ ...values, category: event.target.value })}
          />
        </label>
        {!categoryAllowed && !options.loading && (
          <p className="footnote">
            Choose an active category. Saved unresolved references and archived categories cannot be assigned by a new
            rule.
          </p>
        )}
        {options.error && (
          <p role="alert" className="negative">
            Categories could not be loaded: {options.error}
          </p>
        )}
        <label>
          Transaction type
          <select
            value={values.kind || ''}
            onChange={(event) => setValues({ ...values, kind: event.target.value || undefined })}
          >
            <option value="">Use imported type</option>
            {['expense', 'income', 'transfer', 'refund'].map((kind) => (
              <option key={kind}>{kind}</option>
            ))}
          </select>
        </label>
        <label>
          Priority
          <input
            type="number"
            min="0"
            max="1000"
            value={values.priority}
            onChange={(event) => setValues({ ...values, priority: Number(event.target.value) })}
          />
        </label>
        <TransactionTags
          key={rule?.id || rule?.sourceDescription || 'new-rule'}
          tags={values.tags}
          onChange={(tags) => setValues({ ...values, tags })}
          suggestions={options.tags}
          onDraftChange={setTagDraft}
        />
        <p className="footnote">
          The first matching rule adds tags without replacing existing tags or manual corrections. Explicitly removed
          tags stay removed. At 20 tags, extra rule tags are skipped.
        </p>
        <Button type="button" variant="outline" disabled={!canPreview || busy || previewing} onClick={previewMatches}>
          {previewing ? 'Checking matches…' : 'Preview matches'}
        </Button>
        {currentPreview && (
          <section className="rule-preview" aria-label="Rule preview">
            <p role="status">
              {preview.matchingCount} imported{' '}
              {preview.matchingCount === 1 ? 'transaction matches' : 'transactions match'} this description. Showing up
              to {preview.sampleLimit}.
            </p>
            <p className="footnote">
              Saving applies the rule to matching imported history and future imports. Higher-priority rules and manual
              corrections still take precedence.
            </p>
            <ul>
              {preview.samples.map((sample) => (
                <li key={sample.id}>
                  <strong>{sample.description}</strong>
                  <span>
                    {sample.category} · {sample.kind}
                    {!sample.selectedRuleWins ? ' · Another rule takes precedence' : ''}
                    {sample.manualCorrection ? ' · Manual correction preserved' : ''}
                  </span>
                  <span>Tags to add: {sample.tagsAdded.join(', ') || 'None'}</span>
                  {sample.tagsSuppressed.length > 0 && (
                    <span>Previously removed: {sample.tagsSuppressed.join(', ')}</span>
                  )}
                  {sample.tagsAtCapacity.length > 0 && <span>At tag limit: {sample.tagsAtCapacity.join(', ')}</span>}
                </li>
              ))}
            </ul>
          </section>
        )}
        {(error || serverError) && (
          <p role="alert" className="negative">
            {error || serverError}
          </p>
        )}
        <div className="dialog-actions">
          <Button type="button" variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button disabled={busy || previewing || !currentPreview || !canPreview}>
            {rule?.id ? 'Save rule' : 'Create rule'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
