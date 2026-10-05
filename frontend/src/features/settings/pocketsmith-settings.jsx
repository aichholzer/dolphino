import { useEffect, useRef, useState } from 'react';
import { Button } from '../../components/ui/button';
import { useSettingsDirty } from './settings-dirty';
import { money } from '../../money.mjs';
import { formatStamp } from '../../lib/dates.mjs';

const explain = (code) =>
  ({
    pocketsmith_configuration_changed: 'Settings changed. Reload this section before trying again.',
    pocketsmith_access_denied: 'PocketSmith refused access. Check your saved developer key and test again.',
    pocketsmith_source_missing: 'PocketSmith no longer returned this account. Its local history is retained.',
    pocketsmith_rate_limited: 'PocketSmith requested a pause. Dolphino will respect its retry delay.',
    pocketsmith_test_connection_before_enabling: 'Save the key and test the connection before enabling imports.',
    pocketsmith_credentials_unavailable: 'The saved key cannot be read. Check APP_SECRET or save a new key.',
    pocketsmith_collection_changed: 'Transactions changed during pagination. The complete window will be retried.',
    pocketsmith_backfill_already_queued: 'Finish the queued history import before requesting another range.'
  })[code] || code;

export function PocketSmithSettings({ api, demo, onUpdated }) {
  const [state, setState] = useState(null),
    [key, setKey] = useState(''),
    [days, setDays] = useState(90),
    [enabled, setEnabled] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [ranges, setRanges] = useState({});
  const lifetime = useRef(0),
    flight = useRef(false);
  const dirty = !!state && (Number(days) !== state.backfillDays || enabled !== state.enabled);
  useSettingsDirty(!!key || dirty || busy || Object.values(ranges).some((r) => r.from || r.to));
  function accept(result) {
    setState(result);
    setDays(result.backfillDays);
    setEnabled(result.enabled);
  }

  useEffect(() => {
    const epoch = ++lifetime.current;
    api('/settings/pocketsmith')
      .then((result) => {
        if (epoch === lifetime.current) {
          accept(result);
        }
      })
      .catch((error) => {
        if (epoch === lifetime.current) {
          setError(error.message);
        }
      });
    return () => {
      lifetime.current++;
    };
  }, [api]);

  async function action(path, input, method = 'POST') {
    if (flight.current || !state) {
      return;
    }

    flight.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    const epoch = lifetime.current;
    try {
      const result = await api(`/settings/pocketsmith${path}`, {
        method,
        body: JSON.stringify({ revision: state.revision, ...input })
      });
      if (epoch !== lifetime.current) {
        return;
      }

      accept(result);
      setKey('');
      if (path === '/backfill') {
        setRanges((old) => ({ ...old, [input.accountId]: {} }));
      }

      setNotice(path === '/test' ? 'Connection tested. Select accounts to import.' : 'PocketSmith settings saved.');
      await onUpdated?.();
    } catch (error) {
      if (epoch === lifetime.current) {
        setError(explain(error.message));
      }
    } finally {
      flight.current = false;
      if (epoch === lifetime.current) {
        setBusy(false);
      }
    }
  }

  const disabled = demo || busy || !state;
  return (
    <section className="card settings-card integration-settings" aria-labelledby="pocketsmith-heading">
      <h2 id="pocketsmith-heading">PocketSmith personal import</h2>
      <p className="muted">
        Connect your own PocketSmith account to this personal, self-hosted Dolphino installation. Dolphino reads
        accounts and transactions and polls every four hours when enabled. Your developer key can grant wider
        permissions at PocketSmith; Dolphino only sends read requests.
      </p>
      <p className="muted">
        Create a developer key in PocketSmith Settings → Security. See the{' '}
        <a href="https://developers.pocketsmith.com/docs/introduction" target="_blank" rel="noreferrer">
          official authentication guidance
        </a>
        . Public apps for other users require a separate OAuth registration with PocketSmith.
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
      {!state && <p>Loading PocketSmith settings…</p>}
      {state && (
        <>
          <p>
            <strong>{state.configured ? (state.enabled ? 'Enabled' : 'Paused') : 'Not connected'}</strong>
            {' · '}
            {state.verified ? 'Connection tested' : 'Connection test required'}
          </p>
          {!state.encryptionAvailable && (
            <p className="setup-note">Configure APP_SECRET to encrypt your key in PostgreSQL.</p>
          )}
          {!state.credentialsAvailable && (
            <p role="alert">The stored key cannot be decrypted. Check APP_SECRET or replace the key.</p>
          )}
          {state.lastError && <p role="alert">{explain(state.lastError)}</p>}
          <label>
            Developer key
            <input
              type="password"
              autoComplete="new-password"
              value={key}
              placeholder={state.configured ? 'Saved key: leave blank to keep' : 'Your personal developer key'}
              disabled={disabled || !state.encryptionAvailable}
              onChange={(e) => setKey(e.target.value)}
            />
          </label>
          <label>
            Initial history (days)
            <input
              type="number"
              min="1"
              max="2555"
              value={days}
              disabled={disabled}
              onChange={(e) => setDays(e.target.value)}
            />
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={enabled}
              disabled={disabled || !state.verified || !!key}
              onChange={(e) => setEnabled(e.target.checked)}
            />{' '}
            Enable PocketSmith imports
          </label>
          <div className="settings-actions">
            <Button
              disabled={disabled || (!!key && !state.encryptionAvailable)}
              onClick={() => action('', { key, enabled: key ? false : enabled, backfillDays: Number(days) }, 'PUT')}
            >
              Save PocketSmith settings
            </Button>
            <Button
              variant="outline"
              disabled={disabled || !state.configured || !!key || dirty}
              onClick={() => action('/test', {})}
            >
              Test and discover accounts
            </Button>
            <Button
              variant="outline"
              disabled={disabled || !state.configured}
              onClick={() => action('', { key: null, enabled: false, backfillDays: Number(days) }, 'PUT')}
            >
              Disconnect locally
            </Button>
          </div>
          <p className="muted">
            Disconnecting retains imported history. Revoke the key in PocketSmith to revoke its access.
          </p>
          {state.accounts.length > 0 && (
            <>
              <p className="muted">
                Select native transaction accounts. Grouped account balances are not added again. Importing the same
                bank through another provider can duplicate history; Dolphino does not merge providers.
              </p>
              {state.accounts.map((account) => (
                <div className="card" key={account.id}>
                  <h3>{account.name}</h3>
                  <p>
                    {account.currency} · Native account {account.nativeId}
                    {account.group ? ` · Group: ${account.group.name} (${account.group.id})` : ''}
                  </p>
                  <p>
                    {money(account.balanceMinor, account.currency)} ·{' '}
                    {account.balanceDate ? `Provider balance date ${account.balanceDate}` : 'Balance date unavailable'}
                  </p>
                  <p className="muted">
                    Balance uses your PocketSmith balance settings. It may be calculated, reversed, or based on a bank's
                    available balance.
                  </p>
                  {(account.frozen || account.deleted) && (
                    <p>{account.deleted ? 'Hidden locally' : 'Frozen locally'}; enabled imports continue.</p>
                  )}
                  {account.lastSuccess && <p>Last successful import: {formatStamp(account.lastSuccess)}</p>}
                  {account.lastError && <p role="alert">{explain(account.lastError)}</p>}
                  {account.backfillNext && (
                    <p>
                      History queued: {account.backfillNext} through {account.backfillTo}
                    </p>
                  )}
                  <Button
                    variant="outline"
                    disabled={disabled || dirty || !!key || !state.verified}
                    onClick={() => action('/account', { accountId: account.id, enabled: !account.enabled })}
                  >
                    {account.enabled ? `Pause ${account.name}` : `Import ${account.name}`}
                  </Button>
                  <div className="form-grid">
                    <label>
                      History from: {account.name}
                      <input
                        type="date"
                        disabled={disabled}
                        value={ranges[account.id]?.from || ''}
                        onChange={(e) =>
                          setRanges((old) => ({ ...old, [account.id]: { ...old[account.id], from: e.target.value } }))
                        }
                      />
                    </label>
                    <label>
                      History to: {account.name}
                      <input
                        type="date"
                        disabled={disabled}
                        value={ranges[account.id]?.to || ''}
                        onChange={(e) =>
                          setRanges((old) => ({ ...old, [account.id]: { ...old[account.id], to: e.target.value } }))
                        }
                      />
                    </label>
                  </div>
                  <Button
                    disabled={
                      disabled ||
                      dirty ||
                      !!key ||
                      !account.enabled ||
                      !!account.backfillNext ||
                      !ranges[account.id]?.from ||
                      !ranges[account.id]?.to
                    }
                    onClick={() => action('/backfill', { accountId: account.id, ...ranges[account.id] })}
                  >
                    Queue history for {account.name}
                  </Button>
                </div>
              ))}
            </>
          )}
        </>
      )}
    </section>
  );
}
