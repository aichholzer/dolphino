import { Button } from './ui/button';

const kinds = {
  foundation: 'Foundation model',
  'system-profile': 'System inference profile',
  'application-profile': 'Application inference profile'
};
const unknownProviders = ['Unknown provider', 'Multiple or unknown providers'];

// One optgroup per provider, alphabetical, unknown providers last; model order within a group is the catalog's.
function byProvider(models) {
  const groups = new Map();
  for (const item of models) {
    const name = item.provider || 'Unknown provider';
    groups.set(name, [...(groups.get(name) || []), item]);
  }

  return [...groups].sort(
    ([a], [b]) => Number(unknownProviders.includes(a)) - Number(unknownProviders.includes(b)) || a.localeCompare(b)
  );
}

export function BedrockModelPicker({
  saved,
  provider,
  region,
  credentialsDirty,
  clearsDirty,
  model,
  onModelChange,
  purpose,
  busy,
  disabled = false,
  demo,
  discovery
}) {
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
  const { catalog, loading, error, retry } = discovery;
  const models = catalog?.models || [];
  const unlisted = !!model && !models.some((item) => item.id === model);

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
          {catalog.truncated && (
            <p className="setup-note">This list is incomplete. Reopen AI features to load it again.</p>
          )}
          {(catalog.warnings || []).map((warning, index) => (
            <p className="setup-note" key={index}>
              {warning}
            </p>
          ))}
          {!models.length && (
            <p className="footnote">No matching models were returned. Your saved model is unchanged.</p>
          )}
        </>
      )}
      <label>
        Available {purpose} Bedrock models
        <select
          aria-label={`Available ${purpose} Bedrock models`}
          value={model}
          disabled={!!blocked || !models.length}
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
          {unlisted && (
            <optgroup label="Saved model">
              <option value={model}>{catalog ? `${model} · not in the loaded list` : model}</option>
            </optgroup>
          )}
          {byProvider(models).map(([name, items]) => (
            <optgroup key={name} label={name}>
              {items.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} · {kinds[item.kind] || 'Inference profile'} · {item.lifecycle} · Unverified · {item.id}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
      <p className="footnote">
        A listing does not confirm account access or Converse compatibility. Classification requires Converse, system
        prompts and JSON output{purpose === 'assistant' ? '; the assistant also requires tool use' : ''}. All choices
        are unverified. Legacy models may be listed; check their availability before enabling.
      </p>
    </div>
  );
}
