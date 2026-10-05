import { useEffect, useRef, useState } from 'react';
import { Button } from '../../components/ui/button';
import { api } from '../../lib/api.mjs';
import { useSettingsDirty } from './settings-dirty';
import { formatStamp } from '../../lib/dates.mjs';
export function AccountDataSettings({ onUpdated }) {
  const [accounts, setAccounts] = useState([]),
    [selected, setSelected] = useState([]),
    [preview, setPreview] = useState(null),
    [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false);
  const flight = useRef(false),
    request = useRef(crypto.randomUUID());
  useSettingsDirty(busy || !!preview || !!confirmation || selected.length > 0);
  useEffect(() => {
    let current = true;
    api('/settings/deleted-accounts')
      .then((r) => {
        if (current) {
          setAccounts(r.accounts);
        }
      })
      .catch((e) => {
        if (current) {
          setError(e.message);
        }
      });
    return () => {
      current = false;
    };
  }, []);
  async function run(work) {
    if (flight.current) {
      return;
    }

    flight.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work();
    } catch (e) {
      setError(e.message);
    } finally {
      flight.current = false;
      setBusy(false);
    }
  }

  async function reload() {
    setAccounts((await api('/settings/deleted-accounts')).accounts);
    await onUpdated?.();
  }

  return (
    <section className="card settings-card" aria-busy={busy}>
      <h2>Deleted accounts</h2>
      <p className="muted">
        Soft-deleted accounts and their history are hidden from ordinary reports, budgets, exports and the assistant.
        Restore brings them back. Frozen status is retained. Feed imports continue while hidden when the source supplies
        data; an upstream account disappearing does not delete local history.
      </p>
      {error && (
        <p role="alert" className="negative">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {!accounts.length && <p>No deleted accounts.</p>}
      <ul className="category-settings-list">
        {accounts.map((a) => (
          <li key={a.id}>
            <label className="checkbox-label">
              <input
                type="checkbox"
                disabled={busy}
                checked={selected.includes(a.id)}
                onChange={(e) => {
                  setSelected(e.target.checked ? [...selected, a.id] : selected.filter((id) => id !== a.id));
                  setPreview(null);
                  setConfirmation('');
                }}
              />
              {a.name} · {a.sourceType}
              {a.frozen ? ' · frozen' : ''}
            </label>
            {a.sourceType === 'feed' && (
              <small>Last stored feed update: {a.fetchedAt ? formatStamp(a.fetchedAt) : 'Unavailable'}</small>
            )}
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await api(`/accounts/${a.id}/lifecycle`, {
                    method: 'POST',
                    body: JSON.stringify({
                      requestId: crypto.randomUUID(),
                      revision: a.revision,
                      action: 'restore',
                      reason: 'Restored from Settings > Data'
                    })
                  });
                  setPreview(null);
                  setSelected([]);
                  setConfirmation('');
                  setNotice('Account and historical totals restored.');
                  await reload();
                })
              }
            >
              Restore {a.name}
            </Button>
          </li>
        ))}
      </ul>
      {selected.length > 0 && (
        <Button
          variant="outline"
          disabled={busy}
          onClick={() =>
            run(async () => {
              setPreview(
                await api('/settings/deleted-accounts/preview', {
                  method: 'POST',
                  body: JSON.stringify({ accountIds: selected })
                })
              );
              setConfirmation('');
              request.current = crypto.randomUUID();
            })
          }
        >
          Preview permanent deletion
        </Button>
      )}
      {preview && (
        <div className="deletion-preview">
          <h3>Permanent local deletion</h3>
          <p>
            This cannot be restored. It removes selected accounts, transactions, corrections, tags, manual audit history
            and account-owned import evidence. Shared budgets, rules and category definitions remain. No bank or
            external provider records are deleted.
          </p>
          <p>
            Minimal account/source identity reservations and lifecycle deletion counts remain to prevent automatic
            recreation. This is not a backup erasure operation. Existing backups are unaffected.
          </p>
          <p>
            <strong>Selected: {preview.accounts.map((a) => a.name).join(', ')}</strong>
          </p>
          <dl>
            {Object.entries(preview.counts).map(([key, n]) => (
              <div key={key}>
                <dt>{key.replaceAll('_', ' ')}</dt>
                <dd>{n}</dd>
              </div>
            ))}
          </dl>
          {preview.linkedAccounts.length > 0 ? (
            <p role="alert">
              Linked accounts must also be soft-deleted and explicitly selected:{' '}
              {preview.linkedAccounts.map((a) => a.name).join(', ')}. No other account will be deleted automatically.
            </p>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                run(async () => {
                  await api('/settings/deleted-accounts/purge', {
                    method: 'POST',
                    body: JSON.stringify({
                      requestId: request.current,
                      accountIds: selected,
                      previewToken: preview.previewToken,
                      confirmation
                    })
                  });
                  setPreview(null);
                  setSelected([]);
                  setConfirmation('');
                  setNotice('Selected local accounts permanently deleted. External accounts were not changed.');
                  await reload();
                });
              }}
            >
              <label>
                Type {preview.confirmation}
                <input
                  autoComplete="off"
                  required
                  value={confirmation}
                  onChange={(e) => setConfirmation(e.target.value)}
                />
              </label>
              <Button disabled={busy || confirmation !== preview.confirmation}>
                Permanently delete selected accounts
              </Button>
            </form>
          )}
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              setPreview(null);
              setConfirmation('');
              setSelected([]);
            }}
          >
            Cancel deletion
          </Button>
        </div>
      )}
    </section>
  );
}
