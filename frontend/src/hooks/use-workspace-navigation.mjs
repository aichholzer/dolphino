import { useCallback, useEffect, useRef, useState } from 'react';
import { settingsSection, workspaceHash, workspaceRoute } from '../features/settings/settings-navigation.mjs';

const discardMessage =
  'You have unsaved changes or a save in progress. Leave and discard the draft? A save already sent may still finish.';

export function useWorkspaceNavigation() {
  const [route, setRoute] = useState(() => workspaceRoute(location.hash));
  const dirty = useRef(new Set());
  const current = useRef({ route, position: history.state?.dolphinoPosition ?? 0 });
  const reverting = useRef(false);
  const onDirtyChange = useCallback((value, source = 'settings') => {
    if (value) {
      dirty.current.add(source);
    } else {
      dirty.current.delete(source);
    }
  }, []);
  const confirmLeave = useCallback(() => !dirty.current.size || window.confirm(discardMessage), []);

  useEffect(() => {
    history.replaceState({ ...history.state, dolphinoPosition: current.current.position }, '', location.href);
    function onHistory() {
      const next = workspaceRoute(location.hash);
      if (reverting.current) {
        if (workspaceHash(next) === workspaceHash(current.current.route)) {
          reverting.current = false;
        }

        return;
      }

      if (workspaceHash(next) === workspaceHash(current.current.route)) {
        return;
      }

      const position = history.state?.dolphinoPosition;
      if (!confirmLeave()) {
        if (Number.isInteger(position) && position !== current.current.position) {
          reverting.current = true;
          history.go(current.current.position - position);
        } else {
          history.replaceState(
            { ...history.state, dolphinoPosition: current.current.position },
            '',
            workspaceHash(current.current.route)
          );
        }

        return;
      }

      dirty.current.clear();
      current.current = { route: next, position: position ?? current.current.position + 1 };
      history.replaceState({ ...history.state, dolphinoPosition: current.current.position }, '', location.href);
      setRoute(next);
    }

    function beforeUnload(event) {
      if (dirty.current.size) {
        event.preventDefault();
        event.returnValue = '';
      }
    }

    window.addEventListener('popstate', onHistory);
    window.addEventListener('hashchange', onHistory);
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      window.removeEventListener('popstate', onHistory);
      window.removeEventListener('hashchange', onHistory);
      window.removeEventListener('beforeunload', beforeUnload);
    };
  }, [confirmLeave]);

  const changeRoute = useCallback(
    (page, section = current.current.route.section, { replace = false, force = false, transactionQuery } = {}) => {
      if (!force && !confirmLeave()) {
        return false;
      }

      const next = {
        page,
        section: settingsSection(section),
        ...(page === 'Transactions' && transactionQuery ? { transactionQuery } : {})
      };
      replace = replace || workspaceHash(next) === workspaceHash(current.current.route);
      const position = current.current.position + (replace ? 0 : 1);
      history[replace ? 'replaceState' : 'pushState'](
        { ...history.state, dolphinoPosition: position },
        '',
        workspaceHash(next)
      );
      current.current = { route: next, position };
      dirty.current.clear();
      setRoute(next);
      return true;
    },
    [confirmLeave]
  );

  return { ...route, changeRoute, confirmLeave, onDirtyChange };
}
