import React, { useEffect, useState } from 'react';
import { Button } from './ui/button';
import { useSettingsDirty } from '../features/settings/settings-dirty';

export function IntegrationSettings({ api, demo, onUpdated, status }) {
  const [webhook, setWebhook] = useState(null),
    [redbark, setRedbark] = useState(null),
    [redbarkValues, setRedbarkValues] = useState({ version: '2026-10-01.wattle', backfillDays: 90 }),
    [redbarkSecrets, setRedbarkSecrets] = useState({}),
    [redbarkClears, setRedbarkClears] = useState({}),
    [baseUrl, setBaseUrl] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const redbarkDirty =
    Object.values(redbarkSecrets).some(Boolean) ||
    Object.values(redbarkClears).some(Boolean) ||
    (redbark &&
      (redbarkValues.version !== redbark.version || Number(redbarkValues.backfillDays) !== redbark.backfillDays));
  useSettingsDirty(busy || redbarkDirty || (webhook && baseUrl !== (webhook.publicBaseUrl || '')));
  async function load({ redbarkDraft = false, webhookDraft = false, signal } = {}) {
    const [w, r] = await Promise.all([api('/settings/webhook', { signal }), api('/settings/redbark', { signal })]);
    if (signal?.aborted) {
      return;
    }

    setRedbark(r);
    setWebhook(w);
    if (redbarkDraft) {
      setRedbarkValues({ version: r.version || '2026-10-01.wattle', backfillDays: r.backfillDays ?? 90 });
    }

    if (webhookDraft) {
      setBaseUrl(w.publicBaseUrl || '');
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    load({ redbarkDraft: true, webhookDraft: true, signal: controller.signal }).catch((e) => {
      if (!controller.signal.aborted) {
        setError(e.message);
      }
    });
    return () => controller.abort();
  }, []);
  async function action(fn, options) {
    if (busy) {
      return false;
    }

    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await fn();
      setNotice(result.message || 'Settings updated.');
      await load(options);
      await onUpdated?.();
      return true;
    } catch (e) {
      setError(e.message);
      return false;
    } finally {
      setBusy(false);
    }
  }

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
        <p className="status-pill">
          {status?.verified ? 'Verified' : redbark?.configured ? 'Saved · test required' : 'Not connected'}
        </p>
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

            await action(
              async () => {
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
              },
              { redbarkDraft: true }
            );
          }}
        >
          <fieldset disabled={busy || demo || !redbark}>
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
              need data:read for imports. Existing environment-only configuration is not imported: re-enter it here.
              Keep the same APP_SECRET when restoring your database.
            </p>
            <div className="settings-actions">
              <Button disabled={busy || demo || !redbark}>Save Redbark settings</Button>
              <Button
                type="button"
                variant="outline"
                disabled={busy || demo || !redbark?.configured || !redbark.credentialsAvailable || !!redbarkDirty}
                onClick={() => action(() => api('/connection/test', { method: 'POST', body: '{}' }))}
              >
                Test connection
              </Button>
            </div>
            <p className="footnote">Save credential or import changes before testing the saved connection.</p>
            {demo && <p className="footnote">Integration credential changes are unavailable in the fictional demo.</p>}
          </fieldset>
        </form>
        {status?.lastError && (
          <p role="status" className="alert alert-error">
            {status.lastError}
          </p>
        )}
        <details>
          <summary>Connection status</summary>
          <dl>
            <div>
              <dt>Environment</dt>
              <dd>{demo ? 'Demo · fictional fixtures' : 'Live · authenticated'}</dd>
            </div>
            <div>
              <dt>API version</dt>
              <dd>{redbark?.version || '2026-10-01.wattle'} · beta</dd>
            </div>
            <div>
              <dt>Signed event webhook</dt>
              <dd>{status?.webhookConfigured ? 'Configured' : 'Not configured'}</dd>
            </div>
            <div>
              <dt>Account discovery</dt>
              <dd>Every 4 hours</dd>
            </div>
            <div>
              <dt>Last poll</dt>
              <dd>{status?.lastPollAt ? new Date(status.lastPollAt).toLocaleString() : 'Not yet run'}</dd>
            </div>
          </dl>
        </details>
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
            action(
              async () => {
                await api('/settings/webhook/register', {
                  method: 'POST',
                  body: JSON.stringify({ publicBaseUrl: baseUrl })
                });
                return {
                  message:
                    'Thin-event notifications registered/reused: sync_run.succeeded and connection.refreshed trigger reconciliation. No Redbark sync or live bank-feed subscription was created. Independent four-hour polling remains the fallback.'
                };
              },
              { webhookDraft: true }
            );
          }}
        >
          <fieldset disabled={busy || demo || !webhook}>
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
          </fieldset>
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
