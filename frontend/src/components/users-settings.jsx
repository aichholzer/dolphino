import { useEffect, useState } from 'react';
import { Button } from './ui/button';
import { PasswordForm } from './auth';
export function UsersSettings({ api, session, onSession }) {
  const [data, setData] = useState({ users: [], invitations: [] }),
    [email, setEmail] = useState(''),
    [catalog, setCatalog] = useState({ accounts: [], budgets: [] }),
    [grants, setGrants] = useState({ accounts: [], budgets: [] }),
    [role, setRole] = useState('member'),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  async function load() {
    const [people, options] = await Promise.all([api('/users'), api('/users/grant-options')]);
    setData(people);
    setCatalog(options);
  }
  useEffect(() => {
    if (!session.demo) {
      load().catch((e) => setError(e.message));
    }
  }, []);
  async function action(path, body = {}, method = 'POST') {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const r = await api(path, { method, body: JSON.stringify(body) });
      setNotice(r.message || 'User settings updated.');
      await load();
      return true;
    } catch (e) {
      setError(e.message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card settings-card integration-settings">
      <h2>Household accounts</h2>
      <p className="muted">
        Each person signs in with their own email and password. Only administrators can manage users and integration
        settings.
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
      {session.demo ? (
        <p className="footnote">User management is unavailable in the fictional demo.</p>
      ) : (
        <>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (
                await action('/users/invitations', {
                  email,
                  role,
                  grants: role === 'member' ? grants : { accounts: [], budgets: [] }
                })
              ) {
                setEmail('');
              }
            }}
          >
            <h3>Invite someone</h3>
            <label>
              Invitation email address
              <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
            <label>
              Invitation role
              <select aria-label="Invitation role" value={role} onChange={(e) => setRole(e.target.value)}>
                <option value="member">Member</option>
                <option value="admin">Administrator</option>
              </select>
            </label>
            {role === 'member' && (
              <GrantFields catalog={catalog} grants={grants} setGrants={setGrants} prefix="Invitation" />
            )}
            <p className="footnote">
              An expiring, single-use activation link is sent by email. Members receive no financial access unless you
              grant it explicitly. Administrators can access all household data and settings.
            </p>
            <Button disabled={busy}>Send invitation email</Button>
          </form>
          <h3>People</h3>
          {data.users?.map((u) => (
            <div className="health-account" key={u.id}>
              <strong>
                {u.name || u.email}
                {u.id === session.user?.id ? ' · You' : ''}
              </strong>
              <p className="footnote">
                {u.email} · {u.role === 'admin' ? 'Administrator' : 'Member'}
                {u.disabled ? ' · Disabled' : ''}
              </p>
              {u.role !== 'admin' && (
                <UserGrants
                  user={u}
                  catalog={catalog}
                  busy={busy}
                  save={(g) => action(`/users/${u.id}`, { grants: g }, 'PATCH')}
                />
              )}
              <div className="settings-actions">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy || u.id === session.user?.id}
                  onClick={() => action(`/users/${u.id}`, { role: u.role === 'admin' ? 'member' : 'admin' }, 'PATCH')}
                >
                  {u.role === 'admin' ? 'Revoke administrator' : 'Grant administrator'}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy || u.id === session.user?.id}
                  onClick={() => action(`/users/${u.id}`, { disabled: !u.disabled }, 'PATCH')}
                >
                  {u.disabled ? 'Enable account' : 'Disable account'}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy || u.disabled}
                  onClick={() => action(`/users/${u.id}/reset-password`)}
                >
                  Email password reset
                </Button>
              </div>
            </div>
          ))}
          <p className="footnote">
            Role changes and disabling access revoke sessions. You cannot disable or demote your current account here; a
            remaining administrator is required.
          </p>
          <h3>Invitations & reset emails</h3>
          {!data.invitations?.length && <p className="footnote">No invitations yet.</p>}
          {data.invitations?.map((i) => (
            <div className="health-account" key={i.id}>
              <strong>{i.email}</strong>
              <p className="footnote">
                {i.purpose === 'reset'
                  ? 'Password reset'
                  : i.role === 'admin'
                    ? 'Administrator invitation'
                    : 'Member invitation'}{' '}
                · {i.usedAt ? 'Used' : i.revokedAt ? 'Revoked' : i.deliveryState || 'Pending'}
                <br />
                Expires {new Date(i.expiresAt).toLocaleString()}
                {i.lastError ? ` · ${i.lastError}` : ''}
              </p>
              {!i.usedAt && !i.revokedAt && (
                <div className="settings-actions">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => action(`/users/invitations/${i.id}/resend`)}
                  >
                    Resend email
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => action(`/users/invitations/${i.id}/revoke`)}
                  >
                    Revoke invitation
                  </Button>
                </div>
              )}
            </div>
          ))}
          <PasswordForm api={api} onChanged={() => onSession({ authenticated: false })} />
        </>
      )}
    </section>
  );
}

function GrantFields({ catalog, grants, setGrants, prefix }) {
  function update(kind, id, access) {
    const key = kind === 'accounts' ? 'accountId' : 'budgetId';
    setGrants({
      ...grants,
      [kind]: [...(grants[kind] || []).filter((g) => g[key] !== id), ...(access ? [{ [key]: id, access }] : [])]
    });
  }
  return (
    <div className="grants-editor">
      <p className="footnote">
        Account view shows that account’s balances and transactions and includes it in scoped overview totals. Edit adds
        local account details and transaction corrections. Budget access reveals its full household category totals; it
        does not grant underlying transaction access.
      </p>
      {['accounts', 'budgets'].map((kind) => (
        <div key={kind}>
          <h3>{kind === 'accounts' ? 'Accounts' : 'Budgets'}</h3>
          {!catalog[kind]?.length && <p className="footnote">No {kind} available to grant.</p>}
          {catalog[kind]?.map((item) => {
            const key = kind === 'accounts' ? 'accountId' : 'budgetId',
              title =
                kind === 'accounts'
                  ? `${item.name} · ${item.currency}`
                  : `${item.category} · ${item.month} · ${item.currency}`;
            return (
              <label key={item.id}>
                {title}
                <select
                  aria-label={`${prefix} ${kind === 'accounts' ? 'account' : 'budget'} ${item.id} access`}
                  value={grants[kind]?.find((g) => g[key] === item.id)?.access || ''}
                  onChange={(e) => update(kind, item.id, e.target.value)}
                >
                  <option value="">No access</option>
                  <option value="view">View</option>
                  <option value="edit">View and edit</option>
                </select>
              </label>
            );
          })}
        </div>
      ))}
    </div>
  );
}
function UserGrants({ user, catalog, busy, save }) {
  const [grants, setGrants] = useState(user.grants || { accounts: [], budgets: [] });
  useEffect(() => setGrants(user.grants || { accounts: [], budgets: [] }), [user]);
  return (
    <details className="user-grants">
      <summary>Manage financial access</summary>
      <GrantFields catalog={catalog} grants={grants} setGrants={setGrants} prefix={user.email} />
      <Button variant="outline" size="sm" disabled={busy} onClick={() => save(grants)}>
        Save access for {user.email}
      </Button>
    </details>
  );
}
