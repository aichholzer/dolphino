import { useEffect, useState } from 'react';
import { Button } from './ui/button';
import { useSettingsDirty } from '../features/settings/settings-dirty';
const explanations = {
  simplefin_retry_after_out_of_range:
    'The provider requested an unsupported retry delay of more than ten years. This connection is paused and requires explicit reconnection; no early retry will be attempted.',
  simplefin_existing_account_source_conflict_migration_not_supported:
    'This account already has imported history. Switching its source is blocked until transaction identities can be reconciled safely.',
  simplefin_historical_source_conflict_migration_not_supported:
    'This account belongs to an earlier connection. Relinking historical connections is not supported yet; its existing history is retained.',
  simplefin_redbark_direct_source_active:
    'Direct Redbark is already configured. Keep using it for this account. Importing the same account through SimpleFIN would duplicate its history.',
  simplefin_token_already_attempted_revoke_and_generate_new:
    'This setup token was already attempted. Revoke that token or app connection at your provider and generate a new one.',
  simplefin_test_connection_before_enabling: 'Test the saved connection successfully before enabling imports.',
  simplefin_credentials_unavailable:
    'Saved credentials are unavailable. Verify APP_SECRET. Retired formats require a new connection; historical accounts cannot be automatically relinked. Review the upgrade guide before disconnecting.',
  simplefin_provider_partial:
    'The provider reported incomplete data. Returned records are preserved, but coverage remains incomplete and failed windows will be retried.',
  simplefin_limit_split:
    "The provider's response limit was reached. Smaller date windows have been queued; coverage is not complete yet.",
  simplefin_http_403:
    'The provider refused access. Check whether this app connection was revoked or needs reauthorization.',
  simplefin_http_402: 'The provider requires a paid subscription. Check your provider account.',
  simplefin_http_429: 'The provider rate limit was reached. Imports will resume after its retry delay.'
};
const explain = (message) => explanations[message] || message;
export function SimplefinSettings({ api, demo, onUpdated }) {
  const [state, setState] = useState(null),
    [token, setToken] = useState(''),
    [ack, setAck] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [days, setDays] = useState(30),
    [enabled, setEnabled] = useState(false),
    [ranges, setRanges] = useState({});
  const draftDirty = !!state && (Number(days) !== state.backfillDays || enabled !== state.enabled);
  useSettingsDirty(busy || token || ack || draftDirty || Object.values(ranges).some((range) => range.from || range.to));
  const accept = (value, replaceDraft = true) => {
    setState(value);
    if (!replaceDraft) {
      return;
    }

    setDays(value.backfillDays);
    setEnabled(value.enabled);
  };

  useEffect(() => {
    let active = true;
    api('/settings/simplefin')
      .then((v) => {
        if (active) {
          accept(v);
        }
      })
      .catch((e) => {
        if (active) {
          setError(e.message);
        }
      });
    return () => {
      active = false;
    };
  }, []);
  async function action(path, payload, message, method = 'POST') {
    if (busy) {
      return;
    }

    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await api(`/settings/simplefin${path}`, {
        method,
        body: JSON.stringify(payload)
      });
      accept(result, !draftDirty || (path === '' && method === 'PUT'));
      if (path === '/backfill') {
        setRanges((current) => ({ ...current, [payload.key]: {} }));
      }

      setNotice(result.message || message);
      await onUpdated?.();
    } catch (e) {
      setError(explain(e.message));
    } finally {
      setBusy(false);
    }
  }

  const disabled = demo || busy || !state;
  return (
    <section className="card settings-card integration-settings" aria-labelledby="simplefin-heading">
      <h2 id="simplefin-heading">SimpleFIN optional import</h2>
      <p className="muted">
        Direct Redbark remains the primary integration. SimpleFIN is an optional, read-only protocol for other supported
        providers, including SimpleFIN Bridge. It polls every four hours when enabled; it does not receive bank
        webhooks.
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
      {!state && <p>Loading SimpleFIN settings…</p>}
      {state && (
        <>
          <p>
            <strong>{state.configured ? (state.enabled ? 'Enabled' : 'Paused') : 'Not connected'}</strong>
            {state.providerHost ? ` · ${state.providerHost}` : ''} ·{' '}
            {state.verified ? 'Connection tested' : 'Connection test required'}
          </p>
          {!state.encryptionAvailable && (
            <p className="setup-note">
              Configure a strong APP_SECRET before entering a setup token. It protects the encrypted Access URL in
              PostgreSQL.
            </p>
          )}
          {!state.credentialsAvailable && (
            <p className="setup-note">
              Saved credentials cannot be decrypted. Verify APP_SECRET; retired credential formats cannot be recovered
              by restoring the key. Disconnecting retains financial history, but a new setup token creates a new
              connection and automatic relinking of historical accounts is unsupported. Review the upgrade guide before
              reconnecting.
            </p>
          )}
          {state.lastError && (
            <p role="status" className="setup-note">
              {explain(state.lastError)}
            </p>
          )}
          {state.providerErrors?.length > 0 && (
            <div className="setup-note">
              <strong>Provider reports incomplete data</strong>
              <ul>
                {state.providerErrors.map((message, i) => (
                  <li key={i}>{message}</li>
                ))}
              </ul>
            </div>
          )}
          {!state.configured && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const submitted = token;
                setToken('');
                setAck(false);
                action(
                  '/connect',
                  { token: submitted, acknowledgeAccess: true },
                  'Connection saved and paused. Test it, then choose which new accounts to import.'
                );
              }}
            >
              <label>
                One-use setup token
                <input
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  required
                  maxLength={12000}
                  value={token}
                  onChange={(e) => setToken(e.target.value.trim())}
                  disabled={disabled || !state.encryptionAvailable}
                />
              </label>
              <p className="muted">
                Generate a token in your provider's settings. Redbark tokens expire after seven days. A claim is
                attempted once. If it fails or the outcome is uncertain, revoke that token or app connection at your
                provider and create a new token.
              </p>
              <label className="checkbox-label">
                <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} disabled={disabled} />I
                authorize Dolphino to claim this token and store encrypted read-only access to this provider
              </label>
              <Button type="submit" disabled={disabled || !state.encryptionAvailable || !ack || !token}>
                Connect SimpleFIN
              </Button>
            </form>
          )}
          {state.configured && (
            <>
              <p className="muted">
                Access URL: {state.credential.masked}. Credentials are write-only and never returned to this browser.
              </p>
              <div className="button-row">
                <Button
                  disabled={disabled || !state.credentialsAvailable}
                  onClick={() =>
                    action('/test', {}, 'Connection tested. Review the accounts below before enabling imports.')
                  }
                >
                  Test and discover accounts
                </Button>
              </div>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  action(
                    '',
                    { enabled, backfillDays: Number(days) },
                    enabled ? 'SimpleFIN imports enabled.' : 'SimpleFIN imports paused. Existing history is retained.',
                    'PUT'
                  );
                }}
              >
                <div className="settings-row">
                  <label>
                    Initial import days
                    <input
                      type="number"
                      min="1"
                      max="2555"
                      required
                      value={days}
                      onChange={(e) => setDays(e.target.value)}
                      disabled={disabled}
                    />
                  </label>
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={enabled}
                      onChange={(e) => setEnabled(e.target.checked)}
                      disabled={disabled || !state.verified}
                    />
                    Enable scheduled imports
                  </label>
                </div>
                <p className="muted">
                  Posted transactions only. New mappings use the initial import window. Later polls overlap the previous
                  seven days; use backfill for older changes. Available history depends on your provider, up to seven
                  years.
                </p>
                <Button type="submit" disabled={disabled}>
                  Save SimpleFIN settings
                </Button>
              </form>
              <h3>Account mapping</h3>
              <p className="muted">
                Each account must have one import source. Confirm that a new account is not already imported through
                Redbark or another connection. Source switching and merging existing history are blocked in this
                version.
              </p>
              {state.accounts.length === 0 && <p>No accounts discovered yet. Test the connection to load them.</p>}
              {state.accounts.map((account) => (
                <div className="setup-note simplefin-account" key={account.key}>
                  <strong>{account.name}</strong>
                  <p>
                    {account.institution} · {account.currency} ·{' '}
                    {account.localId ? 'Mapped to Dolphino' : 'Not imported'}
                  </p>
                  {account.redbarkId && (
                    <p className="muted">
                      Redbark account identified. Existing direct imports cannot be linked or duplicated.
                    </p>
                  )}
                  {account.unsupported ? (
                    <p>
                      Custom or unsupported currencies cannot be imported. No currency URL is fetched and no amounts are
                      converted.
                    </p>
                  ) : !account.localId ? (
                    <Button
                      disabled={disabled || !state.verified}
                      onClick={() => {
                        if (
                          window.confirm(
                            `Create a Dolphino account for “${account.name}”? Confirm this bank account is not already imported through Redbark or any other connection. No existing history will be merged.`
                          )
                        ) {
                          action(
                            '/map',
                            { key: account.key, confirmNewAccount: true },
                            'Account mapped. Its initial import is queued and runs only while SimpleFIN is enabled.'
                          );
                        }
                      }}
                    >
                      Map as a new account
                    </Button>
                  ) : (
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        action(
                          '/backfill',
                          { key: account.key, ...ranges[account.key] },
                          'Backfill queued. Existing corrections, categories and splits are preserved.'
                        );
                      }}
                    >
                      <div className="settings-row">
                        <label>
                          Backfill from
                          <input
                            type="date"
                            required
                            disabled={disabled}
                            value={ranges[account.key]?.from || ''}
                            onChange={(e) =>
                              setRanges({
                                ...ranges,
                                [account.key]: {
                                  ...ranges[account.key],
                                  from: e.target.value
                                }
                              })
                            }
                          />
                        </label>
                        <label>
                          Backfill through
                          <input
                            type="date"
                            required
                            disabled={disabled}
                            value={ranges[account.key]?.to || ''}
                            onChange={(e) =>
                              setRanges({
                                ...ranges,
                                [account.key]: {
                                  ...ranges[account.key],
                                  to: e.target.value
                                }
                              })
                            }
                          />
                        </label>
                      </div>
                      <Button type="submit" disabled={disabled || !state.enabled}>
                        Queue account backfill
                      </Button>
                    </form>
                  )}
                </div>
              ))}
            </>
          )}
          <p className="muted">
            Queued windows: {state.queuedJobs} · Historical paused windows: {state.pausedJobs}.{' '}
            {state.lastSuccess
              ? `Last complete response: ${new Date(state.lastSuccess).toLocaleString()}.`
              : 'No complete import response yet.'}{' '}
            {state.nextAttempt ? `Next retry after ${new Date(state.nextAttempt).toLocaleString()}.` : ''}
          </p>
          {state.jobs?.length > 0 && (
            <details>
              <summary>Recent import windows</summary>
              {state.jobs.map((job) => (
                <div className="health-account" key={job.id}>
                  <strong>
                    {job.accountName} · {job.status}
                  </strong>
                  <p className="footnote">
                    {job.from.slice(0, 10)} through {new Date(Date.parse(job.to) - 1000).toISOString().slice(0, 10)} ·
                    Attempts: {job.attempts}
                    {job.lastError ? ` · ${explain(job.lastError)}` : ''}
                  </p>
                </div>
              ))}
            </details>
          )}
          {(state.configured || state.claimPending) && (
            <Button
              variant="outline"
              disabled={disabled}
              onClick={() => {
                if (
                  window.confirm(
                    "Remove Dolphino's saved SimpleFIN credentials and stop future imports? Existing history is retained. You must also revoke this app connection at the provider. Relinking historical accounts is not supported yet."
                  )
                ) {
                  action('/disconnect', { confirm: true }, 'Disconnected locally.');
                }
              }}
            >
              Disconnect locally
            </Button>
          )}
          {state.historicalConnections > 0 && (
            <p className="muted">
              Historical account mappings are retained. Reconnecting cannot automatically merge or relink their
              financial history.
            </p>
          )}
        </>
      )}
    </section>
  );
}
