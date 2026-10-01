import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button } from './ui/button';
import { BedrockModelPicker } from './bedrock-model-picker';

export function IntegrationSettings({ api, demo, onUpdated }) {
  const [settings, setSettings] = useState(null),
    [webhook, setWebhook] = useState(null),
    [redbark, setRedbark] = useState(null),
    [redbarkValues, setRedbarkValues] = useState({
      version: '2026-10-01.wattle',
      backfillDays: 90
    }),
    [redbarkSecrets, setRedbarkSecrets] = useState({}),
    [redbarkClears, setRedbarkClears] = useState({}),
    [values, setValues] = useState({
      provider: 'openai',
      model: '',
      region: '',
      enabled: false,
      autoClassify: false,
      autoApply: false,
      dailyRequestLimit: 20,
      batchSize: 5
    }),
    [secrets, setSecrets] = useState({}),
    [clears, setClears] = useState({}),
    [baseUrl, setBaseUrl] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [loadAfterSave, setLoadAfterSave] = useState(null);
  const saveContext = useMemo(() => ({}), [values, secrets, clears, settings]);
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
  async function load() {
    const [p, w, r] = await Promise.all([
      api('/settings/provider'),
      api('/settings/webhook'),
      api('/settings/redbark')
    ]);
    setSettings(p);
    setValues((v) => ({ ...v, ...p }));
    setRedbark(r);
    setRedbarkValues({
      version: r.version || '2026-10-01.wattle',
      backfillDays: r.backfillDays ?? 90
    });
    setWebhook(w);
    setBaseUrl(w.publicBaseUrl || '');
  }
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, []);
  async function action(fn) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await fn();
      setNotice(result.message || 'Settings updated.');
      await load();
      await onUpdated?.();
      return true;
    } catch (e) {
      setError(e.message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  const secretFields =
    values.provider === 'bedrock'
      ? [
          ['accessKeyId', 'AWS access key ID'],
          ['secretAccessKey', 'AWS secret access key']
        ]
      : [['apiKey', 'OpenAI API key']];
  return (
    <>
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
      <section className="card settings-card integration-settings">
        <h2>Redbark settings</h2>
        <p className="muted">
          Save your API key, API version and rolling import window here. Settings take effect immediately. Credentials
          are encrypted in PostgreSQL and never returned to this form.
        </p>
        {!redbark && <p>Loading Redbark settings…</p>}
        {redbark && !redbark.encryptionAvailable && (
          <p role="status" className="setup-note">
            Credential storage is unavailable. Configure a strong APP_SECRET on the server before entering credentials.
            Imported data stays available.
          </p>
        )}
        {redbark && !redbark.credentialsAvailable && (
          <p role="status" className="setup-note">
            Saved Redbark credentials cannot currently be used. Restore the matching APP_SECRET or replace the saved
            credentials. Operations that need unavailable credentials remain paused.
          </p>
        )}
        {redbark?.credentials?.signingSecret?.configured && redbark.signingSecretAssociated === false && (
          <p role="status" className="setup-note">
            The saved signing secret is not associated with the current API key. Re-register or recover the destination
            below, or explicitly re-enter its signing secret. Webhook processing stays paused until the association is
            verified.
          </p>
        )}
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const payload = {
              version: redbarkValues.version,
              backfillDays: Number(redbarkValues.backfillDays)
            };
            for (const key of ['apiKey', 'signingSecret']) {
              if (redbarkClears[key]) {
                payload[key] = null;
              } else if (redbarkSecrets[key]) {
                payload[key] = redbarkSecrets[key];
              }
            }
            await action(async () => {
              await api('/settings/redbark', {
                method: 'PUT',
                body: JSON.stringify(payload)
              });
              setRedbarkSecrets({});
              setRedbarkClears({});
              return {
                message:
                  'Redbark settings saved. No restart is needed. Test the connection after changing the API key or version before imports can resume.'
              };
            });
          }}
        >
          <div className="settings-row">
            <label>
              Redbark API version
              <input
                required
                maxLength={100}
                value={redbarkValues.version}
                onChange={(e) =>
                  setRedbarkValues({
                    ...redbarkValues,
                    version: e.target.value
                  })
                }
              />
            </label>
            <label>
              Rolling backfill days
              <input
                required
                type="number"
                min="1"
                max="2555"
                step="1"
                value={redbarkValues.backfillDays}
                onChange={(e) =>
                  setRedbarkValues({
                    ...redbarkValues,
                    backfillDays: e.target.value
                  })
                }
              />
            </label>
          </div>
          {[
            ['apiKey', 'Redbark API key'],
            ['signingSecret', 'Redbark signing secret']
          ].map(([key, label]) => {
            const field = (
              <div className="secret-setting">
                <label>
                  {label}
                  <input
                    type="password"
                    autoComplete="new-password"
                    maxLength={key === 'signingSecret' ? 4096 : 8192}
                    minLength={key === 'signingSecret' ? 16 : undefined}
                    value={redbarkSecrets[key] || ''}
                    disabled={!!redbarkClears[key] || !redbark?.encryptionAvailable}
                    placeholder="Leave blank to preserve saved value"
                    onChange={(e) =>
                      setRedbarkSecrets({
                        ...redbarkSecrets,
                        [key]: e.target.value
                      })
                    }
                  />
                </label>
                <div className="secret-state">
                  <span>{redbark?.credentials?.[key]?.configured ? 'Saved · hidden' : 'No saved value'}</span>
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={!!redbarkClears[key]}
                      onChange={(e) =>
                        setRedbarkClears({
                          ...redbarkClears,
                          [key]: e.target.checked
                        })
                      }
                    />
                    Clear saved {key === 'apiKey' ? 'Redbark API key' : 'Redbark signing secret'}
                  </label>
                </div>
              </div>
            );
            return key === 'apiKey' ? (
              <React.Fragment key={key}>{field}</React.Fragment>
            ) : (
              <details key={key}>
                <summary>Existing destination signing secret</summary>
                <p className="footnote">
                  Registration below normally saves the signing secret for you. Use this only to move an existing
                  destination’s secret into Settings. Replacing or clearing it changes which webhook signatures can be
                  verified.
                </p>
                {field}
              </details>
            );
          })}
          <p className="footnote">
            Blank credential fields preserve saved values; selecting Clear removes that value when you save. API keys
            need data:read for imports. Existing environment-only configuration is not imported: re-enter it here. Keep
            the same APP_SECRET when restoring your database.
          </p>
          <Button disabled={busy || demo || !redbark}>Save Redbark settings</Button>
          {demo && <p className="footnote">Integration credential changes are unavailable in the fictional demo.</p>}
        </form>
      </section>
      <section className="card settings-card integration-settings">
        <h2>Optional AI classification</h2>
        <p className="muted">
          Rules, provider categories and your corrections take priority. Enable AI to send only a minimal description
          and permitted categories for unresolved posted imports.
        </p>
        {!settings && <p>Loading provider settings…</p>}
        {settings && !settings.encryptionAvailable && (
          <p role="status" className="setup-note">
            Credential storage is unavailable. Configure a strong APP_SECRET on the server. Your imported financial data
            remains available.
          </p>
        )}
        {settings?.configured && !settings.credentialsAvailable && (
          <p role="status" className="setup-note">
            Saved credentials cannot currently be used. Check the server encryption key or replace the saved values.
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
            const writeSecrets = {};
            for (const [key] of secretFields) {
              if (clears[key]) {
                writeSecrets[key] = null;
              } else if (secrets[key]) {
                writeSecrets[key] = secrets[key];
              }
            }
            setBusy(true);
            setError('');
            setNotice('');
            setLoadAfterSave(null);
            try {
              const saved = await api('/settings/provider', {
                method: 'PUT',
                body: JSON.stringify({
                  provider: values.provider,
                  model: values.model,
                  ...(values.provider === 'bedrock' ? { region: values.region } : {}),
                  enabled: incompleteBedrock ? false : values.enabled,
                  autoClassify: values.autoClassify,
                  autoApply: values.autoApply,
                  dailyRequestLimit: Number(values.dailyRequestLimit),
                  batchSize: Number(values.batchSize),
                  ...writeSecrets
                })
              });
              if (activeSave.current !== request) {
                return;
              }
              if (latestSaveContext.current !== submittedContext) {
                setNotice(
                  'Settings saved, but the form changed while saving. Save your current changes to load models.'
                );
                return;
              }
              const nextValues = { ...values, ...saved };
              setSettings(saved);
              setValues(nextValues);
              setSecrets({});
              setClears({});
              setNotice(
                incompleteBedrock
                  ? 'Credentials and settings saved. AI classification is disabled until you choose a model and enable it.'
                  : 'Settings updated.'
              );
              if (saved.provider === 'bedrock') {
                setLoadAfterSave({ saved, draft: nextValues });
              }
              try {
                await onUpdated?.();
              } catch {
                if (activeSave.current === request && latestSaveContext.current) {
                  setError('Settings saved, but the workspace status could not be refreshed.');
                }
              }
            } catch (error) {
              if (activeSave.current === request && latestSaveContext.current) {
                setError(
                  latestSaveContext.current === submittedContext
                    ? error.message
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
            Provider
            <select
              aria-label="Provider"
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
              endpoint="/settings/provider/models"
              saved={settings}
              provider={values.provider}
              region={values.region}
              credentialsDirty={Object.values(secrets).some(Boolean)}
              clearsDirty={Object.values(clears).some(Boolean)}
              draft={values}
              model={values.model}
              onModelChange={(model) => setValues({ ...values, model, enabled: !!model.trim() && values.enabled })}
              modelLabel="Model or inference profile ID / ARN"
              purpose="classification"
              loadAfterSave={loadAfterSave}
              busy={busy}
              demo={demo}
            />
          ) : (
            <label>
              Model
              <input
                required
                maxLength={500}
                value={values.model}
                placeholder="Enter a supported model ID"
                onChange={(e) => setValues({ ...values, model: e.target.value })}
              />
            </label>
          )}
          {values.provider === 'bedrock' && (
            <label>
              AWS region
              <select
                required
                aria-label="AWS region"
                value={values.region}
                onChange={(e) => setValues({ ...values, region: e.target.value })}
              >
                <option value="">Choose a supported region</option>
                {settings?.regionCatalog?.regions?.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label} · {r.id}
                  </option>
                ))}
              </select>
              <span className="footnote">Permanent access keys only. Model availability varies by region.</span>
            </label>
          )}
          {secretFields.map(([key, label]) => (
            <div className="secret-setting" key={`${values.provider}-${key}`}>
              <label>
                {label}
                <input
                  type="password"
                  autoComplete="new-password"
                  value={secrets[key] || ''}
                  disabled={!!clears[key]}
                  placeholder="Leave blank to preserve saved value"
                  onChange={(e) => setSecrets({ ...secrets, [key]: e.target.value })}
                />
              </label>
              <div className="secret-state">
                <span>
                  {settings?.provider === values.provider && settings?.credentials?.[key]?.configured
                    ? 'Saved · hidden'
                    : 'No saved value'}
                </span>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={!!clears[key]}
                    onChange={(e) => setClears({ ...clears, [key]: e.target.checked })}
                  />
                  Clear saved value
                </label>
              </div>
            </div>
          ))}
          <p className="footnote">
            Credentials are write-only and encrypted in PostgreSQL using your server’s APP_SECRET. Back up that key
            separately. A missing or changed key prevents credential use, while imported data stays available.
          </p>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={!!values.enabled}
              disabled={values.provider === 'bedrock' && !values.model.trim()}
              onChange={(e) => setValues({ ...values, enabled: e.target.checked })}
            />
            Enable AI classification
          </label>
          <p className="footnote">
            {values.provider === 'bedrock' &&
              !values.model.trim() &&
              'Choose a model before enabling. Saving without a model pauses classification. '}
            Turning this off pauses both on-demand and automatic classification. Saved credentials and existing
            suggestions are retained.
          </p>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={!!values.autoClassify}
              onChange={(e) => setValues({ ...values, autoClassify: e.target.checked })}
            />
            Automatically suggest categories for unresolved imports
          </label>
          <p className="footnote">
            Turn automatic suggestions off to keep only on-demand suggestions while AI classification is enabled.
            Existing automatic jobs pause.
          </p>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={!!values.autoApply}
              onChange={(e) => setValues({ ...values, autoApply: e.target.checked })}
            />
            Automatically apply validated category suggestions
          </label>
          <p className="footnote">
            Off by default. Otherwise suggestions wait for your review; invalid or uncertain responses always need
            review.
          </p>
          <div className="settings-row">
            <label>
              Requests per UTC day
              <input
                type="number"
                required
                step="1"
                min="1"
                max="1000"
                value={values.dailyRequestLimit}
                onChange={(e) => setValues({ ...values, dailyRequestLimit: e.target.value })}
              />
            </label>
            <label>
              Maximum import batch
              <input
                type="number"
                required
                step="1"
                min="1"
                max="20"
                value={values.batchSize}
                onChange={(e) => setValues({ ...values, batchSize: e.target.value })}
              />
            </label>
          </div>
          <div className="settings-actions">
            <Button disabled={busy || !settings || demo}>Save provider settings</Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy || demo}
              onClick={() =>
                action(() =>
                  api('/settings/provider/test-connection', {
                    method: 'POST',
                    body: '{}'
                  })
                )
              }
            >
              Test saved connection
            </Button>
          </div>
          <p className="footnote">
            The model test sends harmless synthetic text using your saved configuration. It may incur a tiny inference
            charge. It sends no bank transactions and does not enable classification.
          </p>
          <Button
            type="button"
            variant="outline"
            disabled={busy || demo}
            onClick={() =>
              action(() =>
                api('/settings/provider/test-model', {
                  method: 'POST',
                  body: JSON.stringify({ acknowledgeCost: true })
                })
              )
            }
          >
            Test saved model · may incur cost
          </Button>
          {demo && <p className="footnote">External connection and model tests are unavailable in demo mode.</p>}
        </form>
      </section>
      <section className="card settings-card integration-settings">
        <h2>Redbark thin-event notifications</h2>
        <p className="muted">
          Register signed thin-event notifications that trigger account reconciliation, not a live bank-feed
          subscription. Subscribed events: sync_run.succeeded and connection.refreshed. dolphino does not create a
          Redbark sync.
        </p>
        <dl>
          <div>
            <dt>Registration</dt>
            <dd>{webhook?.state || 'Not registered'}</dd>
          </div>
          <div>
            <dt>Destination</dt>
            <dd>{webhook?.destinationId || '—'}</dd>
          </div>
          <div>
            <dt>Test event receipt</dt>
            <dd>
              {webhook?.pingReceived
                ? 'Received and verified'
                : webhook?.pingEventId
                  ? 'Sent · awaiting callback'
                  : 'Not tested'}
            </dd>
          </div>
        </dl>
        {webhook?.lastError && <p className="negative">{webhook.lastError}</p>}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            action(async () => {
              await api('/settings/webhook/register', {
                method: 'POST',
                body: JSON.stringify({ publicBaseUrl: baseUrl })
              });
              return {
                message:
                  'Thin-event notifications registered/reused: sync_run.succeeded and connection.refreshed trigger reconciliation. No Redbark sync or live bank-feed subscription was created. Independent four-hour polling remains the fallback.'
              };
            });
          }}
        >
          <label>
            Public external HTTPS base URL
            <input
              required
              type="url"
              placeholder="https://dolphino.example.com"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </label>
          <p className="footnote">
            Use a public hostname, not an IP address or private DNS. Redbark must reach the callback without an
            interactive login. Exempt only the callback path from Cloudflare Access; keep the app protected. The
            callback verifies signatures and replay protection.
          </p>
          <div className="settings-actions">
            <Button disabled={busy || demo}>Register / reuse destination</Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy || demo || !webhook?.destinationId}
              onClick={() => action(() => api('/settings/webhook/test', { method: 'POST', body: '{}' }))}
            >
              Send test event
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() =>
                action(async () => {
                  await load();
                  return { message: 'Registration status refreshed.' };
                })
              }
            >
              Refresh status
            </Button>
          </div>
        </form>
        {webhook?.lastError === 'signing_secret_recovery_required' && (
          <div className="setup-note">
            <div>
              <strong>Signing secret recovery required</strong>
              <p>
                Recovery rotates the remote signing secret and saves its replacement encrypted. Existing deliveries
                signed with the previous secret may need retry.
              </p>
              <Button
                disabled={busy || demo}
                variant="outline"
                onClick={() =>
                  action(() =>
                    api('/settings/webhook/register', {
                      method: 'POST',
                      body: JSON.stringify({
                        publicBaseUrl: baseUrl,
                        recoverSigningSecret: true
                      })
                    })
                  )
                }
              >
                Rotate and recover signing secret
              </Button>
            </div>
          </div>
        )}
        <p className="footnote">
          An existing Redbark sync must run successfully to produce sync_run.succeeded. connection.refreshed is not a
          per-transaction notification. Independent four-hour polling remains the fallback even without events, after
          connection verification and subject to outages and retry delays. No instant bank freshness is promised.
          {demo ? ' Registration and remote tests are unavailable in demo mode.' : ''}
        </p>
      </section>
    </>
  );
}
