import { useEffect, useState } from 'react';
import { api } from '../lib/api.mjs';

// Component-local state only. Refetch on opening/navigating; never persist finance
// vocabulary in browser storage or share it across signed-in principals.
export function useCategoryOptions(active = true) {
  const [state, setState] = useState({ catalog: [], tags: [], error: '', loading: true });
  useEffect(() => {
    if (!active) {
      return;
    }

    let current = true;
    setState({ catalog: [], tags: [], error: '', loading: true });
    Promise.all([api('/categories'), api('/tags')])
      .then(([categories, tags]) => {
        if (current) {
          setState({ catalog: categories.catalog || [], tags: tags.tags || [], error: '', loading: false });
        }
      })
      .catch((error) => {
        if (current) {
          setState({ catalog: [], tags: [], error: error.message, loading: false });
        }
      });
    return () => {
      current = false;
    };
  }, [active]);
  return state;
}
