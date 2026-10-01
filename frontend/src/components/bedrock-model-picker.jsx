import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button } from './ui/button';

const kinds = {
  foundation: 'Foundation model',
  'system-profile': 'System inference profile',
  'application-profile': 'Application inference profile'
};
const discoveryError =
  'Unable to load models. Check your saved credentials and region, and IAM permissions for bedrock:ListFoundationModels and bedrock:ListInferenceProfiles. If settings changed, save or refresh them before retrying. You can still enter a model or profile ID manually.';

export function BedrockModelPicker({
  api,
  endpoint,
  saved,
  provider,
  region,
  credentialsDirty,
  clearsDirty,
  draft,
  model,
  onModelChange,
  modelLabel,
  purpose,
  required,
  busy,
  disabled = false,
  demo
}) {
  const [result, setResult] = useState(null),
    [error, setError] = useState(null),
    [search, setSearch] = useState(''),
    [loading, setLoading] = useState(false);
  const active = useRef(null);
  // A fresh saved object also fences refreshes that return the same revision.
  const context = useMemo(
    () => ({}),
    [saved, provider, region, credentialsDirty, clearsDirty, busy, disabled, demo, api, endpoint]
  );
  const requestScope = useMemo(() => ({}), [context, model, draft]);
  useLayoutEffect(() => {
    setResult(null);
    setError(null);
    setSearch('');
  }, [context]);
  useLayoutEffect(() => {
    setLoading(false);
    return () => {
      active.current?.controller.abort();
      active.current = null;
    };
  }, [requestScope]);

  const dirty = credentialsDirty || clearsDirty || saved?.provider !== provider || saved?.region !== region;
  const credentialsReady =
    saved?.provider === 'bedrock' &&
    saved?.credentialsAvailable === true &&
    saved?.encryptionAvailable === true &&
    saved?.credentials?.accessKeyId?.configured &&
    saved?.credentials?.secretAccessKey?.configured &&
    /^[a-f0-9]{64}$/i.test(saved?.discoveryRevision || '');
  const unavailable = dirty || !credentialsReady || !region || provider !== 'bedrock';
  const blocked = unavailable || busy || disabled || demo;
  const catalog = result?.context === context ? result : null;
  const query = search.trim().toLowerCase();
  const matches = (catalog?.models || []).filter((item) =>
    [item.id, item.name, item.provider, kinds[item.kind], item.lifecycle, ...(item.regions || [])]
      .join(' ')
      .toLowerCase()
      .includes(query)
  );
  const selected = catalog?.models.find((item) => item.id === model);

  async function loadModels() {
    // Fence repeated clicks synchronously, before React disables the button.
    if (blocked || active.current) {
      return;
    }
    const request = { controller: new AbortController() };
    active.current = request;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const response = await api(endpoint, {
        method: 'POST',
        body: JSON.stringify({ revision: saved.discoveryRevision }),
        signal: request.controller.signal
      });
      if (active.current !== request) {
        return;
      }
      if (
        response.revision !== saved.discoveryRevision ||
        response.region !== saved.region ||
        !Array.isArray(response.models) ||
        !response.models.every((item) => typeof item.id === 'string' && typeof item.name === 'string')
      ) {
        throw new Error('Invalid or stale discovery result');
      }
      setResult({ ...response, context });
    } catch {
      if (active.current === request) {
        // Do not reflect provider error text, which could contain credentials.
        setError({ context, message: discoveryError });
      }
    } finally {
      if (active.current === request) {
        active.current = null;
        setLoading(false);
      }
    }
  }

  return (
    <div className="bedrock-model-picker">
      <p className="footnote">
        Save credentials, then load models. Leave the model ID blank while disabled to save your AWS keys and region
        first. Loading uses only saved credentials and does not invoke a model or incur inference charges.
      </p>
      <Button type="button" variant="outline" disabled={!!blocked || loading} onClick={loadModels}>
        {loading ? 'Loading models…' : 'Load models'}
      </Button>
      {demo ? (
        <p className="footnote">Model discovery is unavailable in the fictional demo.</p>
      ) : unavailable ? (
        <p className="footnote">
          Save credentials first. Discovery requires saved, usable AWS access and secret keys and the saved region. Save
          any provider, region, credential or Clear changes before loading models.
        </p>
      ) : null}
      {error?.context === context && (
        <p role="alert" className="alert alert-error">
          {error.message}
        </p>
      )}
      {catalog && (
        <>
          <p role="status" className="footnote">
            {catalog.models.length} model or inference profile choices returned for {catalog.region}. No model was
            selected automatically.
          </p>
          {catalog.truncated && (
            <p className="setup-note">This list is incomplete. You can enter another model or profile ID manually.</p>
          )}
          {(catalog.warnings || []).map((warning, index) => (
            <p className="setup-note" key={index}>
              {warning}
            </p>
          ))}
          <label>
            Search {purpose} Bedrock models
            <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} />
          </label>
          <label>
            Available {purpose} Bedrock models
            <select
              aria-label={`Available ${purpose} Bedrock models`}
              value=""
              disabled={!!blocked || !matches.length}
              onChange={(event) => {
                if (event.target.value) {
                  onModelChange(event.target.value);
                }
              }}
            >
              <option value="">Choose a model to fill the ID below</option>
              {matches.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} · {item.provider || 'Provider unknown'} · {kinds[item.kind] || 'Inference profile'} ·{' '}
                  {item.lifecycle} · Unverified · {item.id}
                </option>
              ))}
            </select>
          </label>
          {!matches.length && (
            <p className="footnote">
              {catalog.models.length ? 'No models match this search.' : 'No matching models were returned.'} Your
              current ID is unchanged; manual entry is always available.
            </p>
          )}
        </>
      )}
      <label>
        {modelLabel}
        <input
          required={required}
          maxLength={500}
          value={model}
          placeholder="Choose above or enter a model or inference profile ID / ARN"
          onChange={(event) => onModelChange(event.target.value)}
        />
      </label>
      {selected ? (
        <p className="footnote">
          {selected.name} · {kinds[selected.kind] || 'Inference profile'} · {selected.lifecycle} · Access and
          compatibility unverified.
          {selected.regions?.length ? ` Model regions: ${selected.regions.join(', ')}.` : ''}
        </p>
      ) : (
        model && (
          <p className="footnote">Your current or custom ID is preserved even when it is absent from the list.</p>
        )
      )}
      <p className="footnote">
        A listing does not confirm account access or Converse compatibility. Classification requires Converse, system
        prompts and JSON output{purpose === 'assistant' ? '; the assistant also requires tool use' : ''}. All choices
        are unverified. Legacy models may be listed; check their availability before enabling. Manual model and
        inference profile IDs / ARNs remain supported.
      </p>
    </div>
  );
}
