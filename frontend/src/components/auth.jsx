import { useState } from 'react';
import { BrandMark } from './brand';
import { Button } from './ui/button';

export function AuthScreen({ api, session, onAuthenticated, activationToken }) {
  const mode = activationToken ? 'activate' : session?.setupRequired ? 'bootstrap' : 'login';
  const [email, setEmail] = useState(''),
    [name, setName] = useState(''),
    [password, setPassword] = useState(''),
    [confirm, setConfirm] = useState(''),
    [bootstrapToken, setBootstrapToken] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const creating = mode !== 'login';
  const resetting = mode === 'activate' && location.pathname === '/reset-password';
  return (
    <div className="login-screen">
      <form
        className="card login-card"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            if (creating && password !== confirm) {
              throw Error('Passwords do not match.');
            }
            const path = mode === 'activate' ? '/auth/activate' : mode === 'bootstrap' ? '/auth/bootstrap' : '/login';
            const body =
              mode === 'activate'
                ? {
                    token: activationToken,
                    password,
                    ...(resetting ? {} : { name })
                  }
                : mode === 'bootstrap'
                  ? { email, name, password, bootstrapToken }
                  : { email, password };
            await api(path, { method: 'POST', body: JSON.stringify(body) });
            setPassword('');
            setConfirm('');
            setBootstrapToken('');
            if (mode === 'activate') {
              history.replaceState(null, '', location.pathname);
            }
            const next = await api('/session');
            if (!next.authenticated && !next.demo) {
              setNotice('Account created. Sign in with your email and password.');
              onAuthenticated({ ...next, setupRequired: false });
            } else {
              onAuthenticated(next);
            }
          } catch (e) {
            setError(e.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="brand">
          <BrandMark />
        </div>
        <h1>
          {mode === 'bootstrap'
            ? 'Make yourself at home.'
            : mode === 'activate'
              ? resetting
                ? 'Choose a new password.'
                : 'Join your household.'
              : 'Welcome home.'}
        </h1>
        <p className="muted">
          {mode === 'bootstrap'
            ? 'Create the first administrator using the bootstrap token from your server.'
            : mode === 'activate'
              ? resetting
                ? 'Reset access to your dolphino account.'
                : 'Accept your invitation and set your own password.'
              : 'Sign in to your private financial workspace.'}
        </p>
        {mode !== 'activate' && (
          <label>
            Email address
            <input
              autoComplete="username"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
        )}
        {creating && !resetting && (
          <label>
            Your name
            <input
              autoComplete="name"
              required
              maxLength={120}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
        )}
        {mode === 'bootstrap' && (
          <label>
            Server bootstrap token
            <input
              type="password"
              autoComplete="off"
              required
              value={bootstrapToken}
              onChange={(e) => setBootstrapToken(e.target.value)}
            />
          </label>
        )}
        <label>
          {creating ? 'Choose a password' : 'Your password'}
          <input
            type="password"
            autoComplete={creating ? 'new-password' : 'current-password'}
            required
            minLength={creating ? 12 : undefined}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {creating && (
          <>
            <label>
              Confirm password
              <input
                type="password"
                autoComplete="new-password"
                required
                minLength={12}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </label>
            <p className="footnote">Use at least 12 characters and a unique password.</p>
          </>
        )}
        {error && (
          <p role="alert" className="negative">
            {error}
          </p>
        )}
        {notice && <p role="status">{notice}</p>}
        <Button disabled={busy}>
          {busy
            ? 'Please wait…'
            : mode === 'bootstrap'
              ? 'Create administrator'
              : mode === 'activate'
                ? resetting
                  ? 'Reset my password'
                  : 'Activate my account'
                : 'Sign in'}
        </Button>
        <p className="footnote">
          {mode === 'bootstrap'
            ? 'Your server administrator supplies the bootstrap token. There is no default password.'
            : mode === 'activate'
              ? 'Invitations expire and can be used only once. Request a new invitation if this link no longer works.'
              : 'Your account belongs to this dolphino installation. Contact your administrator if you need access.'}
        </p>
      </form>
    </div>
  );
}

export function PasswordForm({ api, onChanged }) {
  const [current, setCurrent] = useState(''),
    [password, setPassword] = useState(''),
    [confirm, setConfirm] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError('');
        setNotice('');
        try {
          if (password !== confirm) {
            throw Error('Passwords do not match.');
          }
          await api('/auth/change-password', {
            method: 'POST',
            body: JSON.stringify({
              currentPassword: current,
              newPassword: password
            })
          });
          setCurrent('');
          setPassword('');
          setConfirm('');
          setNotice('Password updated. All sessions have been signed out. Sign in with your new password.');
          if (onChanged) {
            onChanged();
          }
        } catch (e) {
          setError(e.message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <h3>Change your password</h3>
      <p className="footnote">Updating your password signs out every session, including this one.</p>
      <label>
        Current password
        <input
          type="password"
          autoComplete="current-password"
          required
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
        />
      </label>
      <label>
        New password
        <input
          type="password"
          autoComplete="new-password"
          minLength={12}
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>
      <label>
        Confirm new password
        <input
          type="password"
          autoComplete="new-password"
          minLength={12}
          required
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
      </label>
      {error && (
        <p role="alert" className="negative">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <Button disabled={busy}>Update password</Button>
    </form>
  );
}

export function AccessPending({ api, session, onSession }) {
  const [error, setError] = useState('');
  return (
    <div className="login-screen">
      <section className="card login-card integration-settings">
        <div className="brand">
          <BrandMark />
        </div>
        <h1>Your account is ready.</h1>
        <p className="muted">
          Signed in as {session.user?.email}. Your administrator has not granted financial access yet. Ask them to
          select the accounts or budgets you can view or edit.
        </p>
        <PasswordForm api={api} onChanged={() => onSession({ authenticated: false })} />
        {error && (
          <p role="alert" className="negative">
            {error}
          </p>
        )}
        <div className="settings-actions">
          <Button
            variant="outline"
            onClick={async () => {
              try {
                onSession(await api('/session'));
              } catch (e) {
                setError(e.message);
              }
            }}
          >
            Check access
          </Button>
          <Button
            variant="outline"
            onClick={async () => {
              try {
                await api('/logout', { method: 'POST' });
                onSession({ authenticated: false });
              } catch (e) {
                setError(e.message);
              }
            }}
          >
            Sign out
          </Button>
        </div>
      </section>
    </div>
  );
}
