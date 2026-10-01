import { useState, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { Button } from './ui/button';
import { BedrockModelPicker } from './bedrock-model-picker';
export function AssistantSettings({ api, demo }) {
  const [data, setData] = useState(null),
    [values, setValues] = useState({
      provider: 'openai',
      model: '',
      region: '',
      enabled: false,
      dataSharingAcknowledged: false,
      dailyRequestsPerUser: 10,
      maxToolCalls: 4,
      maxRounds: 3,
      maxOutputTokens: 1024
    }),
    [secrets, setSecrets] = useState({}),
    [clears, setClears] = useState({}),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [loadAfterSave, setLoadAfterSave] = useState(null);
  const saveContext = useMemo(() => ({}), [values, secrets, clears, data]);
  const latestSaveContext = useRef(null);
  const activeSave = useRef(null);
  useLayoutEffect(() => {
    latestSaveContext.current = saveContext;
    return () => {
      latestSaveContext.current = null;
    };
  }, [saveContext]);
  useEffect(
    () => () => {
      activeSave.current = null;
    },
    []
  );
  useEffect(() => {
    api('/settings/assistant')
      .then((d) => {
        setData(d);
        setValues((v) => ({ ...v, ...d }));
      })
      .catch((e) => setError(e.message));
  }, []);
  const fields =
    values.provider === 'bedrock'
      ? [
          ['accessKeyId', 'Assistant AWS access key ID'],
          ['secretAccessKey', 'Assistant AWS secret access key']
        ]
      : [['apiKey', 'Assistant OpenAI API key']];
  return (
    <section className="card settings-card integration-settings">
      <h2>Read-only financial assistant</h2>
      <p className="muted">
        A separate, optional provider configuration for household questions and reports. Classification credentials are
        never reused.
      </p>
      {error && (
        <p role="alert" className="alert alert-error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="alert alert-success">
          {notice}
        </p>
      )}
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy || activeSave.current || demo) {
            return;
          }
          const request = {};
          activeSave.current = request;
          const submittedContext = saveContext;
          const incompleteBedrock = values.provider === 'bedrock' && !values.model.trim();
          setBusy(true);
          setError('');
          setNotice('');
          setLoadAfterSave(null);
          try {
            const payload = Object.fromEntries(
              [
                'provider',
                'model',
                'region',
                'enabled',
                'dataSharingAcknowledged',
                'dailyRequestsPerUser',
                'maxToolCalls',
                'maxRounds',
                'maxOutputTokens'
              ].map((k) => [k, values[k]])
            );
            if (incompleteBedrock) {
              payload.enabled = false;
            }
            if (values.provider !== 'bedrock') {
              delete payload.region;
            }
            for (const [k] of fields) {
              if (clears[k]) {
                payload[k] = null;
              } else if (secrets[k]) {
                payload[k] = secrets[k];
              }
            }
            const d = await api('/settings/assistant', {
              method: 'PUT',
              body: JSON.stringify(payload)
            });
            if (activeSave.current !== request) {
              return;
            }
            if (latestSaveContext.current !== submittedContext) {
              setNotice('Settings saved, but the form changed while saving. Save your current changes to load models.');
              return;
            }
            d.tools = data?.tools;
            const nextValues = { ...values, ...d };
            setData(d);
            setValues(nextValues);
            setSecrets({});
            setClears({});
            setNotice(
              incompleteBedrock
                ? 'Credentials and settings saved. The assistant is disabled until you choose a model and enable it.'
                : 'Assistant settings saved.'
            );
            if (d.provider === 'bedrock') {
              setLoadAfterSave({ saved: d, draft: nextValues });
            }
          } catch (e) {
            if (activeSave.current === request && latestSaveContext.current) {
              setError(
                latestSaveContext.current === submittedContext
                  ? e.message
                  : 'Settings were not saved. Your current changes are retained; save again to retry.'
              );
            }
          } finally {
            if (activeSave.current === request) {
              activeSave.current = null;
              setBusy(false);
            }
          }
        }}
      >
        <label>
          Assistant provider
          <select
            aria-label="Assistant provider"
            value={values.provider}
            onChange={(e) => {
              setValues({
                ...values,
                provider: e.target.value,
                model: '',
                enabled: false
              });
              setSecrets({});
              setClears({});
            }}
          >
            <option value="openai">OpenAI</option>
            <option value="bedrock">Amazon Bedrock</option>
          </select>
        </label>
        {values.provider === 'bedrock' ? (
          <BedrockModelPicker
            api={api}
            endpoint="/settings/assistant/models"
            saved={data}
            provider={values.provider}
            region={values.region}
            credentialsDirty={Object.values(secrets).some(Boolean)}
            clearsDirty={Object.values(clears).some(Boolean)}
            draft={values}
            model={values.model}
            onModelChange={(model) => setValues({ ...values, model, enabled: !!model.trim() && values.enabled })}
            modelLabel="Assistant model ID"
            purpose="assistant"
            loadAfterSave={loadAfterSave}
            busy={busy}
            demo={demo}
          />
        ) : (
          <label>
            Assistant model ID
            <input
              required
              value={values.model}
              maxLength={500}
              onChange={(e) => setValues({ ...values, model: e.target.value })}
            />
          </label>
        )}
        {values.provider === 'bedrock' && (
          <label>
            Assistant AWS region
            <select
              aria-label="Assistant AWS region"
              required
              value={values.region}
              onChange={(e) => setValues({ ...values, region: e.target.value })}
            >
              <option value="">Choose a region</option>
              {data?.regionCatalog?.regions?.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label} · {r.id}
                </option>
              ))}
            </select>
          </label>
        )}
        {fields.map(([k, label]) => (
          <div key={`${values.provider}-${k}`}>
            <label>
              {label}
              <input
                type="password"
                autoComplete="new-password"
                disabled={clears[k]}
                value={secrets[k] || ''}
                placeholder="Leave blank to preserve saved value"
                onChange={(e) => setSecrets({ ...secrets, [k]: e.target.value })}
              />
            </label>
            <div className="secret-state">
              <span>
                {data?.provider === values.provider && data?.credentials?.[k]?.configured
                  ? 'Saved · hidden'
                  : 'No saved value'}
              </span>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={!!clears[k]}
                  onChange={(e) => setClears({ ...clears, [k]: e.target.checked })}
                />
                Clear saved value
              </label>
            </div>
          </div>
        ))}
        <p className="footnote">
          Encrypted with your server’s APP_SECRET. Bedrock uses permanent access keys only. Model availability depends
          on region and provider access.
        </p>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={!!values.dataSharingAcknowledged}
            onChange={(e) =>
              setValues({
                ...values,
                dataSharingAcknowledged: e.target.checked
              })
            }
          />
          I understand authorized financial tool results and user questions are sent to this provider. Each user must
          also acknowledge sharing before sending.
        </label>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={!!values.enabled}
            disabled={values.provider === 'bedrock' && !values.model.trim()}
            onChange={(e) => setValues({ ...values, enabled: e.target.checked })}
          />
          Enable the household assistant
        </label>
        {values.provider === 'bedrock' && !values.model.trim() && (
          <p className="footnote">Choose a model before enabling. Saving without a model pauses the assistant.</p>
        )}
        <div className="settings-row">
          {[
            ['dailyRequestsPerUser', 'Daily requests per user', 1, 100],
            ['maxToolCalls', 'Tool calls per answer', 1, 8],
            ['maxRounds', 'Model rounds per answer', 1, 4],
            ['maxOutputTokens', 'Maximum output tokens', 128, 2048]
          ].map(([k, label, min, max]) => (
            <label key={k}>
              {label}
              <input
                type="number"
                required
                min={min}
                max={max}
                value={values[k]}
                onChange={(e) => setValues({ ...values, [k]: Number(e.target.value) })}
              />
            </label>
          ))}
        </div>
        <p className="footnote">
          Provider inference may incur charges. Read-only tools are bounded by these limits and the signed-in user’s
          account and budget permissions. Chats expire after 30 minutes or a server restart.
        </p>
        {data?.disabledReason && <p className="footnote">{data.disabledReason}</p>}
        <Button disabled={busy || demo || !data}>Save assistant settings</Button>
        {demo && (
          <p className="footnote">Assistant credentials and external calls cannot be enabled in the fictional demo.</p>
        )}
      </form>
      <details className="assistant-tool-catalog">
        <summary>Available read-only tools</summary>
        {(data?.tools || []).map((tool, i) => (
          <div className="health-account" key={tool.name || i}>
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
    </section>
  );
}
