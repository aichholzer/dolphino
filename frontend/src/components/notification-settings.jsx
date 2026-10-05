import { useState, useEffect } from 'react';
import { Button } from './ui/button';
import { useSettingsDirty } from '../features/settings/settings-dirty';
import { formatStamp } from '../lib/dates.mjs';
export function NotificationSettings({ api, demo }) {
  const [data, setData] = useState(null),
    [deliveries, setDeliveries] = useState([]),
    [audienceConfirmed, setAudienceConfirmed] = useState(false),
    [summaryFields, setSummaryFields] = useState(['category', 'period', 'amount', 'remaining']),
    [smtp, setSmtp] = useState({ enabled: false, from: '', recipients: [] }),
    [telegram, setTelegram] = useState({ enabled: false }),
    [smtpUrl, setSmtpUrl] = useState(''),
    [token, setToken] = useState(''),
    [clearSmtp, setClearSmtp] = useState(false),
    [clearToken, setClearToken] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [pairing, setPairing] = useState(null);
  const dirty =
    !!smtpUrl ||
    !!token ||
    clearSmtp ||
    clearToken ||
    (data &&
      (audienceConfirmed !== !!data.audienceConfirmed ||
        JSON.stringify(summaryFields) !==
          JSON.stringify(data.summaryFields || ['category', 'period', 'amount', 'remaining']) ||
        JSON.stringify(smtp) !== JSON.stringify(data.smtp || {}) ||
        JSON.stringify(telegram) !== JSON.stringify(data.telegram || {})));
  const telegramReady =
    !!data?.telegram?.credentialConfigured && data.telegram.credentialsAvailable !== false && !token && !clearToken;
  const smtpReady =
    !!data?.smtp?.credentialConfigured &&
    data.smtp.credentialsAvailable !== false &&
    !!data.smtp.from &&
    !!data.smtp.recipients?.length &&
    !smtpUrl &&
    !clearSmtp;
  useSettingsDirty(dirty || busy);
  async function load({ preserveDraft = false, refreshTelegram = false } = {}) {
    const [d, history, activePairing] = await Promise.all([
      api('/settings/notifications'),
      api('/notifications/deliveries'),
      api('/settings/telegram/pair')
    ]);
    setDeliveries(Array.isArray(history) ? history : []);
    if (activePairing.active) {
      setPairing((p) => (p?.pairingId === activePairing.pairingId ? { ...p, ...activePairing } : activePairing));
    } else {
      setPairing(null);
    }

    setData(d);
    setTelegram((current) => ({
      ...d.telegram,
      enabled: preserveDraft && !refreshTelegram && d.telegram?.paired ? current.enabled : !!d.telegram?.enabled
    }));
    if (preserveDraft) {
      return;
    }

    setAudienceConfirmed(!!d.audienceConfirmed);
    setSummaryFields(d.summaryFields || ['category', 'period', 'amount', 'remaining']);
    setSmtp(d.smtp || {});
  }

  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, []);
  async function action(fn, { saveForm = false, refreshTelegram = false } = {}) {
    if (busy) {
      return null;
    }

    setBusy(true);
    setError('');
    setNotice('');
    try {
      const r = await fn();
      setNotice(r.message || 'Notification settings updated.');
      await load({ preserveDraft: dirty && !saveForm, refreshTelegram });
      return r;
    } catch (e) {
      setError(e.message);
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function save(e) {
    e.preventDefault();
    const body = {
      summaryFields,
      audienceConfirmed,
      smtp: {
        enabled: !!smtp.enabled,
        from: smtp.from || '',
        recipients: (smtp.recipients || []).filter(Boolean),
        ...(clearSmtp ? { smtpUrl: null } : smtpUrl ? { smtpUrl } : {})
      },
      telegram: {
        enabled: token || clearToken ? false : !!telegram.enabled,
        ...(clearToken ? { token: null } : token ? { token } : {})
      }
    };
    if (
      await action(
        () =>
          api('/settings/notifications', {
            method: 'PUT',
            body: JSON.stringify(body)
          }),
        { saveForm: true }
      )
    ) {
      setSmtpUrl('');
      setToken('');
      setClearSmtp(false);
      setClearToken(false);
    }
  }

  return (
    <section className="card settings-card integration-settings notification-settings">
      <h2>Keep the household in the loop</h2>
      <p className="muted">
        Optional delivery of budget alerts. In-app alerts remain available with every delivery channel turned off.
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
      <form id="notification-settings-form" className="notification-step" onSubmit={save}>
        <div className="notification-step-heading">
          <span>1</span>
          <h3>Save credentials and sharing preferences</h3>
        </div>
        <fieldset disabled={busy || demo || !data}>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={audienceConfirmed}
              onChange={(e) => setAudienceConfirmed(e.target.checked)}
            />
            I understand notifications can show whole-household category totals to these email and Telegram recipients,
            independently of their app permissions.
          </label>
          <h3>What to share</h3>
          <p className="footnote">
            Choose fields included in household budget summaries. Bank account names and transaction descriptions are
            never included.
          </p>
          {[
            ['category', 'Category'],
            ['period', 'Budget period'],
            ['amount', 'Overspend amount'],
            ['remaining', 'Remaining allowance']
          ].map(([key, label]) => (
            <label key={key} className="checkbox-label">
              <input
                type="checkbox"
                checked={summaryFields.includes(key)}
                disabled={summaryFields.length === 1 && summaryFields.includes(key)}
                onChange={(e) =>
                  setSummaryFields(e.target.checked ? [...summaryFields, key] : summaryFields.filter((f) => f !== key))
                }
              />
              {label}
            </label>
          ))}
          <div className="setup-note">
            <div>
              <strong>Synthetic summary preview</strong>
              <p>
                {summaryFields
                  .map(
                    (f) =>
                      ({
                        category: 'Dining',
                        period: 'September 2026',
                        amount: 'Over budget by AUD 12.34',
                        remaining: 'Remaining: −AUD 12.34'
                      })[f]
                  )
                  .join(' · ')}
              </p>
            </div>
          </div>

          <h3>Email · SMTP</h3>
          <label>
            SMTP connection URL
            <input
              type="password"
              autoComplete="new-password"
              value={smtpUrl}
              disabled={clearSmtp}
              placeholder="Leave blank to preserve saved connection"
              onChange={(e) => setSmtpUrl(e.target.value)}
            />
          </label>
          <p className="footnote">
            {data?.smtp?.credentialConfigured ? 'Saved · hidden. ' : 'Not configured. '}
            Use smtp://login:password@host:587 with STARTTLS or smtps://login:password@host:465. URL-encode special
            characters in credentials. Connection details are encrypted.
          </p>
          {data?.smtp?.credentialsAvailable === false && (
            <p role="status" className="setup-note">
              The saved SMTP connection cannot be decrypted. Verify APP_SECRET or replace the saved connection. Retired
              credential formats must be replaced; financial records are unchanged.
            </p>
          )}
          <label className="checkbox-label">
            <input type="checkbox" checked={clearSmtp} onChange={(e) => setClearSmtp(e.target.checked)} />
            Clear SMTP connection
          </label>
          <label>
            From email address
            <input type="email" value={smtp.from || ''} onChange={(e) => setSmtp({ ...smtp, from: e.target.value })} />
          </label>
          <label>
            Recipients (comma separated)
            <input
              value={(smtp.recipients || []).join(', ')}
              onChange={(e) =>
                setSmtp({
                  ...smtp,
                  recipients: e.target.value.split(',').map((s) => s.trim())
                })
              }
            />
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={!!smtp.enabled}
              onChange={(e) => setSmtp({ ...smtp, enabled: e.target.checked })}
            />
            Enable email alerts
          </label>
          <h3>Telegram · private household group</h3>
          <label>
            Telegram bot token
            <input
              type="password"
              autoComplete="new-password"
              value={token}
              disabled={clearToken}
              placeholder="Leave blank to preserve saved token"
              onChange={(e) => setToken(e.target.value)}
            />
          </label>
          <label className="checkbox-label">
            <input type="checkbox" checked={clearToken} onChange={(e) => setClearToken(e.target.checked)} />
            Clear Telegram bot token
          </label>
          {data?.telegram?.credentialsAvailable === false && (
            <p role="status" className="setup-note">
              The saved Telegram token cannot be decrypted. Verify APP_SECRET or replace the saved token. Retired
              credential formats must be replaced. Replacing the token requires pairing the group again.
            </p>
          )}
          <p className="footnote">
            Create a dedicated private group and add your household members. After saving the bot token, use Pair
            Telegram group to choose that group in Telegram. Keep bot privacy mode on; no administrator permissions are
            needed. dolphino does not manage membership.
          </p>
          <p className="footnote">
            {telegram.paired ? `Paired group: ${telegram.chatTitle || 'confirmed household'}. ` : 'No group paired. '}
            Save your bot token before starting group pairing.
          </p>
          <div className="settings-actions">
            <Button disabled={busy || demo || !data}>Save notification settings</Button>
          </div>
        </fieldset>
      </form>
      <div className="notification-step">
        <div className="notification-step-heading">
          <span>2</span>
          <h3>Pair and confirm your Telegram group</h3>
        </div>
        <p className="footnote">
          Use the saved bot token to choose a private group. Check its name and ID before confirming.
        </p>
        <div className="settings-actions">
          <Button
            variant="outline"
            disabled={busy || demo || !telegramReady}
            onClick={async () => {
              const r = await action(() =>
                api('/settings/telegram/pair', {
                  method: 'POST',
                  body: '{}'
                })
              );
              if (r) {
                setPairing(r);
                setNotice('Choose your private group using the Telegram link below.');
              }
            }}
          >
            Pair Telegram group
          </Button>
        </div>
        {pairing && (
          <div className="setup-note">
            <div>
              <strong>Confirm the group before enabling delivery</strong>
              {pairing.expiresAt && (
                <p className="footnote">
                  Expires {formatStamp(pairing.expiresAt)}. Start pairing again if this expires.
                </p>
              )}
              {pairing.deepLink && (
                <p>
                  <Button asChild>
                    <a href={pairing.deepLink} target="_blank" rel="noreferrer">
                      Choose group in Telegram
                    </a>
                  </Button>
                </p>
              )}
              <p className="footnote">
                The link opens Telegram’s group chooser and sends the pairing command when you select your private
                group. You do not need to type /start. Then return here, check for your group and confirm its name and
                ID.
              </p>
              {pairing.command && (
                <details>
                  <summary>Group link not working? Use a manual command</summary>
                  <p className="footnote">
                    Add the bot to your intended private group, then paste this entire command there. A plain /start
                    does not identify this pairing request.
                  </p>
                  <p>
                    <code>{pairing.command}</code>
                  </p>
                </details>
              )}
              {!pairing.deepLink && (
                <p className="footnote">
                  The pairing link is only shown when pairing starts. If you have not used it yet, start pairing again
                  for a new link.
                </p>
              )}
              <Button
                variant="outline"
                disabled={busy || demo || !telegramReady}
                onClick={async () => {
                  const r = await action(() =>
                    api('/settings/telegram/poll', {
                      method: 'POST',
                      body: JSON.stringify({ pairingId: pairing.pairingId })
                    })
                  );
                  if (r) {
                    setPairing({ ...pairing, ...r });
                    if (r.active) {
                      setNotice(
                        r.candidate
                          ? 'Group found. Check its name and ID below before confirming.'
                          : 'No matching group yet. Choose your group using the Telegram link, then check again. If the link did not send the command, use the manual fallback.'
                      );
                    }
                  }
                }}
              >
                Check for group
              </Button>
              {pairing.candidate && (
                <div>
                  <p>
                    <strong>{pairing.candidate.title}</strong>
                    <br />
                    Group ID: {pairing.candidate.chatId}
                  </p>
                  <Button
                    disabled={busy || demo || !telegramReady}
                    onClick={async () => {
                      const r = await action(
                        () =>
                          api('/settings/telegram/confirm', {
                            method: 'POST',
                            body: JSON.stringify({
                              pairingId: pairing.pairingId,
                              chatId: pairing.candidate.chatId
                            })
                          }),
                        { refreshTelegram: true }
                      );
                      if (r) {
                        setPairing(null);
                      }
                    }}
                  >
                    Confirm group and enable Telegram alerts
                  </Button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
      <div className="notification-step">
        <div className="notification-step-heading">
          <span>3</span>
          <h3>Manage delivery and send a test</h3>
        </div>
        <p className="footnote">
          Group confirmation enables Telegram alerts when your saved sharing consent allows it. You can pause alerts
          here.
        </p>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={!!telegram.enabled}
            disabled={busy || demo || !telegramReady || !telegram.paired}
            onChange={(e) => setTelegram({ ...telegram, enabled: e.target.checked })}
          />
          Enable Telegram alerts to the confirmed group
        </label>
        <div className="settings-actions">
          <Button
            type="submit"
            form="notification-settings-form"
            disabled={busy || demo || !telegramReady || !telegram.paired || !dirty}
          >
            Save delivery settings
          </Button>
        </div>
        <p className="footnote">
          Send test delivers a synthetic message to the configured recipients or confirmed group. No financial
          transactions are included.
        </p>
        <div className="settings-actions">
          {['smtp', 'telegram'].map((channel) => (
            <Button
              key={channel}
              variant="outline"
              disabled={busy || demo || (channel === 'telegram' ? !telegramReady || !telegram.paired : !smtpReady)}
              onClick={() =>
                action(() =>
                  api('/notifications/test', {
                    method: 'POST',
                    body: JSON.stringify({ channel })
                  })
                )
              }
            >
              Send {channel === 'smtp' ? 'email' : 'Telegram'} test
            </Button>
          ))}
        </div>
      </div>
      <p className="footnote">
        {data?.pendingCount || 0} pending deliveries · {data?.failedCount || 0} failed deliveries
      </p>
      {data?.recentFailures?.map((r, i) => (
        <p key={i} className="footnote negative">
          {r.channel}: {r.error} · {r.attempts} attempts
        </p>
      ))}
      <h3>Recent deliveries</h3>
      {!deliveries.length && <p className="footnote">No recent deliveries.</p>}
      {deliveries.slice(0, 10).map((d) => (
        <div className="health-account" key={d.id}>
          <strong>
            {d.channel} · {d.status}
          </strong>
          <p className="footnote">
            {d.attempts} attempts{d.error ? ` · ${d.error}` : ''}
          </p>
          {d.status === 'failed' && (
            <Button
              variant="outline"
              disabled={busy || demo}
              onClick={() =>
                action(() =>
                  api(`/notifications/${d.id}/retry`, {
                    method: 'POST',
                    body: '{}'
                  })
                )
              }
            >
              Retry delivery {d.id}
            </Button>
          )}
        </div>
      ))}
      {demo && (
        <p className="footnote">Saving credentials, pairing and external delivery are unavailable in demo mode.</p>
      )}
    </section>
  );
}
