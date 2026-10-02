import { useEffect, useState } from 'react';
import { Button } from './ui/button';

const kinds = {
  foundation: 'Foundation model',
  'system-profile': 'System inference profile',
  'application-profile': 'Application inference profile'
};
export function BedrockModelPicker({
  saved,
  provider,
  region,
  credentialsDirty,
  clearsDirty,
  model,
  onModelChange,
  modelLabel,
  purpose,
  busy,
  disabled = false,
  demo,
  discovery
}) {
  const [search, setSearch] = useState('');
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
  const { key, catalog, loading, error, retry } = discovery;
  useEffect(() => setSearch(''), [key]);
  const query = search.trim().toLowerCase();
  const matches = (catalog?.models || []).filter((item) =>
    [item.id, item.name, item.provider, kinds[item.kind], item.lifecycle, ...(item.regions || [])]
      .join(' ')
      .toLowerCase()
      .includes(query)
  );
  const selected = catalog?.models.find((item) => item.id === model);

  return (
    <div className="bedrock-model-picker">
      <p className="footnote">
        Save the shared AWS credentials and region above to automatically load models for both features. Saved
        credentials also load models when you reopen AI features. Choose a model and explicitly enable each feature.
        Loading does not invoke a model or incur inference charges.
      </p>
      {loading && (
        <p role="status" className="footnote">
          Loading models from your saved credentials…
        </p>
      )}
      {demo ? (
        <p className="footnote">Model discovery is unavailable in the fictional demo.</p>
      ) : unavailable ? (
        <p className="footnote">
          Save the shared AWS access and secret keys and region above. Choices load automatically after saving usable
          credentials.
        </p>
      ) : null}
      {error && (
        <>
          <p role="alert" className="alert alert-error">
            {error} Your saved settings and credentials are retained.
          </p>
          <Button type="button" variant="outline" disabled={!!blocked || loading} onClick={retry}>
            Retry loading models
          </Button>
        </>
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
          {!matches.length && (
            <p className="footnote">
              {catalog.models.length ? 'No models match this search.' : 'No matching models were returned.'} Your
              current ID is unchanged; manual entry is always available.
            </p>
          )}
        </>
      )}
      <label>
        Available {purpose} Bedrock models
        <select
          aria-label={`Available ${purpose} Bedrock models`}
          value={matches.some((item) => item.id === model) ? model : ''}
          disabled={!!blocked || !matches.length}
          onChange={(event) => {
            if (event.target.value) {
              onModelChange(event.target.value);
            }
          }}
        >
          <option value="">
            {catalog
              ? 'Choose a model or inference profile'
              : loading
                ? 'Loading models…'
                : error
                  ? 'Models could not be loaded'
                  : 'Save credentials and region to load models'}
          </option>
          {matches.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name} · {item.provider || 'Provider unknown'} · {kinds[item.kind] || 'Inference profile'} ·{' '}
              {item.lifecycle} · Unverified · {item.id}
            </option>
          ))}
        </select>
      </label>
      <details>
        <summary>Enter a model or inference profile ID manually (optional)</summary>
        <label>
          {modelLabel}
          <input
            maxLength={500}
            value={model}
            placeholder="Optional model or inference profile ID / ARN"
            onChange={(event) => onModelChange(event.target.value)}
          />
        </label>
      </details>
      {model && <p className="footnote">Selected model or profile: {model}</p>}
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
