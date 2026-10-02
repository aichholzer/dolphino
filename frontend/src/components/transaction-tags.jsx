import { useEffect, useId, useState } from 'react';
import { X } from 'lucide-react';
import { Button } from './ui/button';

export function TransactionTags({ tags, onChange, suggestions, onDraftChange }) {
  const [draft, setDraft] = useState('');
  const id = useId();
  useEffect(() => {
    onDraftChange?.(draft);
  }, [draft, onDraftChange]);
  function add() {
    const tag = draft.trim().toLowerCase();
    if (tag && tag.length <= 40 && tags.length < 20) {
      onChange([...new Set([...tags, tag])].sort());
      setDraft('');
    }
  }

  return (
    <fieldset className="transaction-tags">
      <legend>Tags</legend>
      <p className="footnote">Add labels such as work or holiday. Tags do not change categories or spending totals.</p>
      <div className="tag-list">
        {tags.map((tag) => (
          <span className="category-tag" key={tag}>
            {tag}
            <button
              type="button"
              aria-label={`Remove tag ${tag}`}
              onClick={() => onChange(tags.filter((value) => value !== tag))}
            >
              <X size={13} />
            </button>
          </span>
        ))}
      </div>
      <div className="tag-entry">
        <input
          aria-label="New tag"
          placeholder="e.g. work"
          maxLength={40}
          list={id}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              add();
            }
          }}
        />
        <datalist id={id}>
          {suggestions
            .filter((tag) => !tags.includes(tag))
            .map((tag) => (
              <option key={tag} value={tag} />
            ))}
        </datalist>
        <Button type="button" variant="outline" disabled={!draft.trim() || tags.length >= 20} onClick={add}>
          Add tag
        </Button>
      </div>
      {draft.trim() && <p className="footnote">Choose Add tag or press Enter to include this label before saving.</p>}
    </fieldset>
  );
}
