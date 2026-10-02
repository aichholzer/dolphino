import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useSettingsDirty } from '../features/settings/settings-dirty';

// select must be stable and return only editable fields, never API metadata.
// Both reads and writes are fenced against newer edits and section unmounts.
export function useSettingsForm({ api, endpoint, select, initial, refreshKey }) {
  const [data, setData] = useState(null);
  const [values, setValues] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [outdated, setOutdated] = useState(false);
  const [reload, setReload] = useState(0);
  const dirty = !!data && JSON.stringify(values) !== JSON.stringify(select(data));
  const latest = useRef(null);
  const activeSave = useRef(null);
  const generation = useRef(0);
  useLayoutEffect(() => {
    latest.current = { values, data, dirty };
    return () => {
      latest.current = null;
    };
  }, [values, data, dirty]);
  useSettingsDirty(dirty || busy);
  useEffect(() => {
    const request = ++generation.current;
    const started = latest.current;
    const controller = new AbortController();
    api(endpoint, { signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted || request !== generation.current || !latest.current) {
          return;
        }

        if (latest.current !== started || started?.dirty) {
          setOutdated(true);
          return;
        }

        setData(result);
        setValues(select(result));
        setOutdated(false);
        setError('');
      })
      .catch((failure) => {
        if (!controller.signal.aborted && request === generation.current) {
          setError(failure.message);
        }
      });
    return () => controller.abort();
  }, [api, endpoint, select, refreshKey, reload]);
  useEffect(
    () => () => {
      activeSave.current = null;
    },
    []
  );

  const discardAndReload = useCallback(() => {
    if (latest.current?.dirty && !window.confirm('Discard this form’s unsaved changes and reload saved settings?')) {
      return;
    }

    if (latest.current?.data) {
      setValues(select(latest.current.data));
    }

    setReload((value) => value + 1);
  }, [select]);

  async function save(payload, message, onSaved) {
    if (!data || activeSave.current) {
      return false;
    }

    const request = {};
    activeSave.current = request;
    const submitted = latest.current;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await api(endpoint, { method: 'PUT', body: JSON.stringify(payload) });
      if (activeSave.current !== request || !latest.current) {
        return false;
      }

      if (latest.current !== submitted) {
        setOutdated(true);
        setNotice(
          'Settings saved, but the form changed while saving. Your current changes are retained. Reload saved settings before saving again.'
        );
        return false;
      }

      // Feature PUT responses omit the read-only tool catalog returned by GET.
      setData(data.tools && !result.tools ? { ...result, tools: data.tools } : result);
      setValues(select(result));
      setOutdated(false);
      setNotice(message);
      try {
        await onSaved?.(result);
      } catch {
        if (activeSave.current === request && latest.current) {
          setError('Settings saved, but the workspace status could not be refreshed.');
        }
      }

      return true;
    } catch (failure) {
      if (activeSave.current === request && latest.current) {
        setError(
          latest.current === submitted
            ? failure.message
            : 'Settings were not saved. Your current changes are retained; save again to retry.'
        );
      }

      return false;
    } finally {
      if (activeSave.current === request) {
        activeSave.current = null;
        setBusy(false);
      }
    }
  }

  return { data, values, setValues, busy, error, setError, notice, setNotice, dirty, outdated, save, discardAndReload };
}
