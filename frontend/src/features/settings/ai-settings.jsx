import { useState } from 'react';
import { Button } from '../../components/ui/button';
import { BedrockModelPicker } from '../../components/bedrock-model-picker';
import { useBedrockModels } from '../../hooks/use-bedrock-models.mjs';
import { useSettingsForm } from '../../hooks/use-settings-form.mjs';
import { useSettingsDirty } from './settings-dirty';

const sharedValues = (data = {}) => ({
  provider: data.provider || 'openai',
  region: data.region || '',
  apiKey: '',
  accessKeyId: '',
  secretAccessKey: '',
  clearApiKey: false,
  clearAccessKeyId: false,
  clearSecretAccessKey: false,
  reuseCredentialsFrom: ''
});
const classificationValues = (data = {}) => ({
  model: data.model || '',
  enabled: !!data.enabled,
  autoClassify: !!data.autoClassify,
  autoApply: !!data.autoApply,
  dailyRequestLimit: data.dailyRequestLimit ?? 20,
  batchSize: data.batchSize ?? 5
});
const assistantValues = (data = {}) => ({
  model: data.model || '',
  enabled: !!data.enabled,
  dataSharingAcknowledged: !!data.dataSharingAcknowledged
});

function FormMessages({ form }) {
  return (
    <>
      {form.error && (
        <p role="alert" className="alert alert-error">
          {form.error}
        </p>
      )}
      {form.notice && (
        <p role="status" className="alert alert-success">
          {form.notice}
        </p>
      )}
      {form.outdated && (
        <div className="setup-note">
          <p>
            Saved settings changed. Your unsaved edits are retained. Reload this form to review the saved connection
            before saving again.
          </p>
          <Button type="button" variant="outline" disabled={form.busy} onClick={form.discardAndReload}>
            Reload saved settings
          </Button>
        </div>
      )}
    </>
  );
}

function bedrockReady(shared, dirty, demo) {
  return (
    !demo &&
    !dirty &&
    shared?.provider === 'bedrock' &&
    !['conflict', 'credentials-unavailable'].includes(shared?.migration?.status) &&
    shared?.credentialsAvailable === true &&
    shared?.encryptionAvailable === true &&
    shared?.credentials?.accessKeyId?.configured &&
    shared?.credentials?.secretAccessKey?.configured &&
    !!shared?.region &&
    /^[a-f0-9]{64}$/i.test(shared?.discoveryRevision || '')
  );
}

export function AiSettings({ api, demo, onUpdated }) {
  const form = useSettingsForm({ api, endpoint: '/settings/ai', select: sharedValues, initial: sharedValues() });
  const { data: shared, values, setValues } = form;
  const [testing, setTesting] = useState(false);
  useSettingsDirty(testing);
  const discovery = useBedrockModels({
    api,
    endpoint: '/settings/ai/models',
    saved: shared,
    eligible: bedrockReady(shared, form.dirty || form.outdated, demo)
  });
  const fields =
    values.provider === 'bedrock'
      ? [
          ['accessKeyId', 'AWS access key ID', 'clearAccessKeyId'],
          ['secretAccessKey', 'AWS secret access key', 'clearSecretAccessKey']
        ]
      : [['apiKey', 'OpenAI API key', 'clearApiKey']];
  const conflict = ['conflict', 'credentials-unavailable'].includes(shared?.migration?.status);
  const featureBlocked = !shared || conflict || shared?.settingsAvailable === false || form.outdated;
  const change = (key, value) => setValues({ ...values, [key]: value });
  return (
    <>
      <section className="card settings-card integration-settings" aria-labelledby="shared-ai-heading">
        <h2 id="shared-ai-heading">Shared AI connection</h2>
        <p className="muted">
          Choose your provider and enter credentials once. Classification and the assistant use this connection, with
          their own models and controls below.
        </p>
        <FormMessages form={form} />
        {!shared && !form.error && <p role="status">Loading AI settings…</p>}
        {shared?.migration?.status !== 'ready' && shared?.migration?.message && (
          <p role="status" className="setup-note">
            {shared.migration.message}
          </p>
        )}
        {shared && !shared.encryptionAvailable && (
          <p className="setup-note">
            Credential storage is unavailable. Configure a strong APP_SECRET on the server before entering credentials.
            Imported financial data stays available.
          </p>
        )}
        {shared?.configured && !shared.credentialsAvailable && (
          <p className="setup-note">
            {shared.disabledReason ||
              'Saved credentials cannot be used. Current-format credentials require the matching APP_SECRET; retired credential formats must be re-entered.'}
          </p>
        )}
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            if (demo || form.outdated) {
              return;
            }

            const payload = { provider: values.provider, revision: shared.discoveryRevision };
            if (values.provider === 'bedrock') {
              payload.region = values.region;
            }

            if (values.reuseCredentialsFrom) {
              payload.reuseCredentialsFrom = values.reuseCredentialsFrom;
            }

            for (const [key, , clear] of fields) {
              if (values[clear]) {
                payload[key] = null;
              } else if (values[key]) {
                payload[key] = values[key];
              }
            }

            await form.save(
              payload,
              'Shared AI connection saved. Connection changes pause both features; review their settings below before enabling them.',
              async () => {
                await onUpdated?.();
              }
            );
          }}
        >
          <fieldset disabled={!shared || demo}>
            {conflict && (
              <label>
                Resolve existing AI credentials
                <select
                  aria-label="Resolve existing AI credentials"
                  value={values.reuseCredentialsFrom}
                  onChange={(event) => {
                    const source = shared.migration.sources.find((item) => item.id === event.target.value);
                    setValues({
                      ...sharedValues(shared),
                      provider: source?.provider || values.provider,
                      region: source?.region || '',
                      reuseCredentialsFrom: event.target.value
                    });
                  }}
                >
                  <option value="">Enter shared credentials below</option>
                  {(shared.migration.sources || []).map((source) => (
                    <option
                      key={source.id}
                      value={source.id}
                      disabled={!source.credentialsAvailable || !source.configured}
                    >
                      Use saved {source.id} credentials · {source.provider}
                      {source.region ? ` · ${source.region}` : ''}
                      {!source.credentialsAvailable ? ' · unavailable' : ''}
                    </option>
                  ))}
                </select>
                <span className="footnote">
                  Existing configurations differ. Choose which saved credentials to share, or enter a new connection.
                  Both features remain paused until you resolve this.
                </span>
              </label>
            )}
            <label>
              AI provider
              <select
                aria-label="AI provider"
                value={values.provider}
                onChange={(event) =>
                  setValues({ ...sharedValues(shared), provider: event.target.value, region: values.region })
                }
              >
                <option value="openai">OpenAI</option>
                <option value="bedrock">Amazon Bedrock</option>
              </select>
            </label>
            {values.provider === 'bedrock' && (
              <label>
                AWS region
                <select
                  aria-label="AWS region"
                  disabled={!!values.reuseCredentialsFrom}
                  required
                  value={values.region}
                  onChange={(event) => change('region', event.target.value)}
                >
                  <option value="">Choose a supported region</option>
                  {(shared?.regionCatalog?.regions || []).map((region) => (
                    <option key={region.id} value={region.id}>
                      {region.label} · {region.id}
                    </option>
                  ))}
                </select>
                <span className="footnote">Permanent access keys only. Model availability varies by region.</span>
              </label>
            )}
            {fields.map(([key, label, clear]) => (
              <div className="secret-setting" key={`${values.provider}-${key}`}>
                <label>
                  {label}
                  <input
                    type="password"
                    autoComplete="new-password"
                    maxLength={8192}
                    value={values[key]}
                    disabled={values[clear] || !shared?.encryptionAvailable || !!values.reuseCredentialsFrom}
                    placeholder="Leave blank to preserve saved value"
                    onChange={(event) => change(key, event.target.value)}
                  />
                </label>
                <div className="secret-state">
                  <span>
                    {shared?.provider === values.provider && shared?.credentials?.[key]?.configured
                      ? 'Saved · hidden'
                      : 'No saved value'}
                  </span>
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={values[clear]}
                      disabled={!!values.reuseCredentialsFrom}
                      onChange={(event) => change(clear, event.target.checked)}
                    />
                    Clear saved {label}
                  </label>
                </div>
              </div>
            ))}
            <p className="footnote">
              Credentials are write-only and encrypted in PostgreSQL using your server’s APP_SECRET. Blank fields keep
              saved values; Clear removes them on save. Credentials are never stored in this browser. A model is not
              required to save the connection.
            </p>
            <p className="footnote">
              Changing provider, region or credentials pauses classification and the assistant. Changing provider also
              clears incompatible model choices.
            </p>
            <div className="settings-actions">
              <Button disabled={form.busy || testing || form.outdated}>Save AI connection</Button>
              <Button
                type="button"
                variant="outline"
                disabled={form.busy || testing || form.dirty || featureBlocked || !shared?.configured}
                onClick={async () => {
                  if (testing) {
                    return;
                  }

                  setTesting(true);
                  form.setError('');
                  form.setNotice('');
                  try {
                    const result = await api('/settings/ai/test-connection', { method: 'POST', body: '{}' });
                    form.setNotice(result.message || 'Saved connection tested.');
                  } catch (error) {
                    form.setError(error.message);
                  } finally {
                    setTesting(false);
                  }
                }}
              >
                Test saved connection
              </Button>
            </div>
          </fieldset>
          {demo && (
            <p className="footnote">Credential changes and external calls are unavailable in the fictional demo.</p>
          )}
        </form>
      </section>
      {shared && (
        <>
          <AiFeatureSettings
            api={api}
            demo={demo}
            shared={shared}
            connectionDirty={form.dirty}
            blocked={featureBlocked}
            discovery={discovery}
            purpose="classification"
            onUpdated={onUpdated}
          />
          <AiFeatureSettings
            api={api}
            demo={demo}
            shared={shared}
            connectionDirty={form.dirty}
            blocked={featureBlocked}
            discovery={discovery}
            purpose="assistant"
          />
        </>
      )}
    </>
  );
}

function AiFeatureSettings({ api, demo, shared, connectionDirty, blocked, discovery, purpose, onUpdated }) {
  const assistant = purpose === 'assistant';
  const endpoint = assistant ? '/settings/assistant' : '/settings/provider';
  const select = assistant ? assistantValues : classificationValues;
  const form = useSettingsForm({ api, endpoint, select, initial: select(), refreshKey: shared.discoveryRevision });
  const { data, values, setValues } = form;
  const [testing, setTesting] = useState(false);
  useSettingsDirty(testing);
  const changedConnection = !!data && data.discoveryRevision !== shared.discoveryRevision;
  const disabled = blocked || changedConnection || form.outdated || connectionDirty;
  const provider = ['conflict', 'credentials-unavailable'].includes(shared.migration?.status)
    ? data?.provider
    : shared.provider;
  const change = (key, value) => setValues({ ...values, [key]: value });
  return (
    <section className="card settings-card integration-settings" aria-labelledby={`${purpose}-heading`}>
      <h2 id={`${purpose}-heading`}>{assistant ? 'Read-only financial assistant' : 'Optional AI classification'}</h2>
      <p className="muted">
        {assistant
          ? 'Optional household questions and reports. Uses the shared AI connection above; enabling it requires financial data-sharing acknowledgement.'
          : 'Rules, provider categories and your corrections take priority. AI sends only a minimal description and permitted categories for unresolved posted imports.'}
      </p>
      <FormMessages form={form} />
      {changedConnection && !form.outdated && (
        <div className="setup-note">
          <p>
            The shared connection changed. Your edits are retained. Reload saved settings before saving this feature.
          </p>
          <Button type="button" variant="outline" onClick={form.discardAndReload}>
            Reload saved settings
          </Button>
        </div>
      )}
      {connectionDirty && (
        <p className="footnote">Save the shared AI connection above before changing feature settings.</p>
      )}
      {blocked && (
        <p className="setup-note">Resolve the shared AI connection above before enabling or saving this feature.</p>
      )}
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (demo || disabled) {
            return;
          }

          await form.save(
            { ...values, enabled: values.model.trim() ? values.enabled : false, aiRevision: data.discoveryRevision },
            `${assistant ? 'Assistant' : 'Classification'} settings saved.`,
            onUpdated
          );
        }}
      >
        <fieldset disabled={!data || demo || disabled}>
          {provider === 'bedrock' ? (
            <BedrockModelPicker
              saved={shared}
              provider={provider}
              region={shared.region}
              credentialsDirty={connectionDirty}
              model={values.model}
              onModelChange={(model) => setValues({ ...values, model, enabled: !!model.trim() && values.enabled })}
              purpose={purpose}
              busy={form.busy || testing}
              disabled={disabled}
              demo={demo}
              discovery={discovery}
            />
          ) : (
            <label>
              {assistant ? 'Assistant model ID' : 'Classification model ID'}
              <input
                maxLength={500}
                value={values.model}
                placeholder="Enter a supported model ID"
                onChange={(event) => change('model', event.target.value)}
              />
            </label>
          )}
          {assistant && data?.disclosure && <p className="setup-note">{data.disclosure}</p>}
          {assistant && (
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={values.dataSharingAcknowledged}
                onChange={(event) => change('dataSharingAcknowledged', event.target.checked)}
              />
              I understand authorized financial tool results and user questions are sent to this provider.
            </label>
          )}
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={values.enabled}
              disabled={!values.model.trim()}
              onChange={(event) => change('enabled', event.target.checked)}
            />
            {assistant ? 'Enable the household assistant' : 'Enable AI classification'}
          </label>
          {!values.model.trim() && (
            <p className="footnote">Choose a model before enabling. Saving without a model pauses {purpose}.</p>
          )}
          {!assistant && (
            <>
              <p className="footnote">
                Turning this off pauses on-demand and automatic classification. Saved credentials and existing
                suggestions are retained.
              </p>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={values.autoClassify}
                  onChange={(event) => change('autoClassify', event.target.checked)}
                />
                Automatically suggest categories for unresolved imports
              </label>
              <p className="footnote">
                Turn automatic suggestions off to keep only on-demand suggestions. Existing automatic jobs pause.
              </p>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={values.autoApply}
                  onChange={(event) => change('autoApply', event.target.checked)}
                />
                Automatically apply validated category suggestions
              </label>
              <p className="footnote">
                Off by default. Otherwise suggestions wait for your review; invalid or uncertain responses always need
                review.
              </p>
            </>
          )}
          {!assistant && (
            <div className="settings-row">
              {[
                ['dailyRequestLimit', 'Requests per UTC day', 1, 1000],
                ['batchSize', 'Maximum import batch', 1, 20]
              ].map(([key, label, min, max]) => (
                <label key={key}>
                  {label}
                  <input
                    type="number"
                    required
                    step="1"
                    min={min}
                    max={max}
                    value={values[key]}
                    onChange={(event) => change(key, Number(event.target.value))}
                  />
                </label>
              ))}
            </div>
          )}
          <p className="footnote">
            {assistant
              ? 'Provider inference may incur charges. Read-only tools respect the signed-in user’s account and budget permissions. Chats expire after 30 minutes or a server restart.'
              : 'Provider inference may incur charges.'}
          </p>
          {data?.disabledReason && <p className="footnote">{data.disabledReason}</p>}
          <Button disabled={form.busy || testing}>
            {assistant ? 'Save assistant settings' : 'Save classification settings'}
          </Button>
          {!assistant && (
            <>
              <p className="footnote">
                The model test sends harmless synthetic text using your saved configuration. It may incur a tiny
                inference charge. It sends no bank transactions and does not enable classification.
              </p>
              <Button
                type="button"
                variant="outline"
                disabled={form.busy || testing || form.dirty}
                onClick={async () => {
                  if (testing) {
                    return;
                  }

                  setTesting(true);
                  form.setError('');
                  form.setNotice('');
                  try {
                    const result = await api(`${endpoint}/test-model`, {
                      method: 'POST',
                      body: JSON.stringify({ acknowledgeCost: true })
                    });
                    form.setNotice(result.message || 'Saved model tested.');
                  } catch (error) {
                    form.setError(error.message);
                  } finally {
                    setTesting(false);
                  }
                }}
              >
                Test saved model · may incur cost
              </Button>
            </>
          )}
        </fieldset>
      </form>
      {assistant && (
        <details className="assistant-tool-catalog">
          <summary>Available read-only tools</summary>
          {(data?.tools || []).map((tool, index) => (
            <div className="health-account" key={tool.name || index}>
              <strong>{tool.name || tool.function?.name}</strong>
              <p className="footnote">{tool.description || tool.function?.description}</p>
            </div>
          ))}
          {!data?.tools?.length && (
            <p className="footnote">
              The server tool catalog is unavailable. Tool authorization is enforced on every request.
            </p>
          )}
        </details>
      )}
    </section>
  );
}
