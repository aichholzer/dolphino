import { useLayoutEffect } from 'react';

export function useDraftGuard(onDirtyChange, source, dirty) {
  useLayoutEffect(() => {
    onDirtyChange?.(!!dirty, source);
    return () => onDirtyChange?.(false, source);
  }, [onDirtyChange, source, dirty]);
}
