import { useEffect, useRef, useState } from 'react';

const discoveryError =
  'Unable to load models. Check your saved credentials and region, and IAM permissions for bedrock:ListFoundationModels and bedrock:ListInferenceProfiles. If settings changed, save or refresh them before retrying. You can still enter a model or profile ID manually.';

// A catalog belongs to the server-issued credential/configuration revision, not
// a particular Save click, form object or unrelated busy/refresh transition.
export function useBedrockModels({ api, endpoint, saved, eligible }) {
  const revision = saved?.discoveryRevision;
  const region = saved?.region;
  const key = eligible ? JSON.stringify([endpoint, revision, region]) : null;
  const [state, setState] = useState(null);
  const [attempt, setAttempt] = useState(0);
  const active = useRef(null);
  const retryPending = useRef(false);

  useEffect(() => {
    retryPending.current = false;
    if (!key) {
      return;
    }

    const request = { controller: new AbortController() };
    active.current = request;
    setState({ key, status: 'loading' });
    (async () => {
      // React can immediately replay effects in development. Let cleanup cancel
      // an abandoned effect before it sends a duplicate external catalog read.
      await Promise.resolve();
      if (active.current !== request || request.controller.signal.aborted) {
        return;
      }

      try {
        const response = await api(endpoint, {
          method: 'POST',
          body: JSON.stringify({ revision }),
          signal: request.controller.signal
        });
        if (active.current !== request || request.controller.signal.aborted) {
          return;
        }

        if (
          response.revision !== revision ||
          response.region !== region ||
          !Array.isArray(response.models) ||
          response.models.length > 1000 ||
          !response.models.every((item) => typeof item.id === 'string' && typeof item.name === 'string') ||
          (response.warnings !== undefined &&
            (!Array.isArray(response.warnings) || !response.warnings.every((item) => typeof item === 'string')))
        ) {
          throw new Error('Invalid or stale discovery result');
        }

        setState({ key, status: 'ready', catalog: response });
      } catch {
        if (active.current === request && !request.controller.signal.aborted) {
          // Raw provider/API error text must never enter the rendered catalog.
          setState({ key, status: 'error', error: discoveryError });
        }
      } finally {
        if (active.current === request) {
          active.current = null;
        }
      }
    })();

    return () => {
      request.controller.abort();
      if (active.current === request) {
        active.current = null;
      }
    };
  }, [api, endpoint, key, revision, region, attempt]);

  const current = key && state?.key === key ? state : null;
  return {
    key,
    catalog: current?.status === 'ready' ? current.catalog : null,
    error: current?.status === 'error' ? current.error : null,
    loading: Boolean(key && (!current || current.status === 'loading')),
    retry: () => {
      if (!key || current?.status !== 'error' || active.current || retryPending.current) {
        return;
      }

      retryPending.current = true;
      setAttempt((value) => value + 1);
    }
  };
}
