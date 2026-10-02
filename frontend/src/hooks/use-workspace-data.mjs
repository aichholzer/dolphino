import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.mjs';
import { reportPath } from '../lib/report-query.mjs';
import { workspaceAccess } from '../lib/workspace-access.mjs';

// This hook lives inside the principal-keyed workspace, never across sign-ins.
export function useWorkspaceData({ session, onSession, page, query, search }) {
  const requestId = useRef(0);
  const lifetime = useRef(0);
  const currentLoad = useRef(null);
  const [data, setData] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    return () => {
      // Requests from an unmounted principal cannot publish data or trigger reloads.
      requestId.current++;
      lifetime.current++;
      currentLoad.current = null;
    };
  }, []);

  const load = useCallback(
    async ({ background = false } = {}) => {
      const activeRequest = ++requestId.current;
      const isCurrent = () => activeRequest === requestId.current;
      if (!session) {
        try {
          const next = await api('/session');
          if (isCurrent()) {
            onSession(next);
          }
        } catch (error) {
          if (isCurrent()) {
            setError(error.message);
            setLoading(false);
          }
        }

        return;
      }

      const access = workspaceAccess(session);
      if ((!session.demo && (!session.authenticated || !access.hasFinancialAccess)) || !access.canNavigate(page)) {
        return;
      }

      if (!background) {
        setLoading(true);
      }

      setError('');
      try {
        const result = await api(reportPath(page, query));
        if (isCurrent()) {
          setData(result);
        }
      } catch (error) {
        if (isCurrent()) {
          setError(error.message);
        }
      } finally {
        if (isCurrent()) {
          setLoading(false);
        }
      }
    },
    [session, onSession, page, query]
  );

  useEffect(() => {
    currentLoad.current = load;
    const timer = setTimeout(load, search ? 220 : 0);
    return () => clearTimeout(timer);
  }, [load, search]);

  const refreshCurrent = useCallback(() => currentLoad.current?.({ background: true }), []);

  function resetPage() {
    requestId.current++;
    setLoading(true);
    setError('');
    setNotice('');
    setData({});
  }

  async function mutate(path, body, method = 'POST') {
    const activeLifetime = lifetime.current;
    setBusy(true);
    setError('');
    try {
      const result = await api(path, { method, body: JSON.stringify(body) });
      if (activeLifetime !== lifetime.current) {
        return false;
      }

      setNotice(result.message || 'Changes saved.');
      // A mutation can finish after navigation. Refresh the current report, not its old closure.
      await currentLoad.current();
      return activeLifetime === lifetime.current;
    } catch (error) {
      if (activeLifetime === lifetime.current) {
        setError(error.message);
      }

      return false;
    } finally {
      if (activeLifetime === lifetime.current) {
        setBusy(false);
      }
    }
  }

  return { data, loading, error, notice, setNotice, busy, load, mutate, resetPage, refreshCurrent };
}
