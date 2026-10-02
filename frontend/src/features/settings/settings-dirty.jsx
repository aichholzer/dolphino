import { createContext, useCallback, useContext, useId, useLayoutEffect, useRef } from 'react';

const DirtySettings = createContext(null);

export function SettingsDrafts({ onDirtyChange, children }) {
  const drafts = useRef(new Set());
  const register = useCallback(
    (id, dirty) => {
      if (dirty) {
        drafts.current.add(id);
      } else {
        drafts.current.delete(id);
      }

      onDirtyChange(drafts.current.size > 0);
    },
    [onDirtyChange]
  );
  useLayoutEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  return <DirtySettings.Provider value={register}>{children}</DirtySettings.Provider>;
}

// Drafts, including write-only credentials, live only in the mounted section.
export function useSettingsDirty(dirty) {
  const register = useContext(DirtySettings);
  const id = useId();
  useLayoutEffect(() => {
    register?.(id, !!dirty);
    return () => register?.(id, false);
  }, [id, register, dirty]);
}
