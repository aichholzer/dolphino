import { useLayoutEffect, useState } from 'react';
import { Search, X } from 'lucide-react';

export function GlobalSearch({ canSearch, activeSearch, routeKey, onSearch }) {
  const [draft, setDraft] = useState(activeSearch || '');
  useLayoutEffect(() => {
    setDraft(activeSearch || '');
  }, [activeSearch, routeKey]);
  return (
    <form
      role="search"
      aria-label="Global transaction search"
      className="global-search"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSearch) {
          onSearch(draft.trim());
        }
      }}
    >
      <Search size={17} aria-hidden="true" />
      <input
        type="search"
        aria-label="Search all transactions"
        maxLength={200}
        value={draft}
        disabled={!canSearch}
        placeholder={canSearch ? 'Search transactions…' : 'Transaction access required'}
        onChange={(event) => setDraft(event.target.value)}
      />
      {(draft || activeSearch) && (
        <button
          type="button"
          aria-label="Clear global search"
          disabled={!canSearch}
          onClick={() => {
            if (onSearch('')) {
              setDraft('');
            }
          }}
        >
          <X size={15} />
        </button>
      )}
      <button type="submit" disabled={!canSearch} aria-label="Run global search">
        Search
      </button>
    </form>
  );
}
