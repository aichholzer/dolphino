import { useEffect, useState } from 'react';
import { api } from './lib/api.js';
import { workspaceAccess, workspaceIdentity } from './lib/workspace-access.js';
import { AuthScreen, AccessPending } from './components/auth';
import { FinancialWorkspace } from './financial-workspace';

export function App() {
  const [session, setSession] = useState(null);
  const [activationToken, setActivationToken] = useState(
    () => new URLSearchParams(location.hash.slice(1)).get('token') || ''
  );
  useEffect(() => {
    if (location.hash.includes('token=')) {
      history.replaceState(null, '', location.pathname + location.search);
    }
  }, []);

  if (session && !session.demo && (activationToken || !session.authenticated)) {
    return (
      <AuthScreen
        api={api}
        session={session}
        activationToken={activationToken}
        onAuthenticated={(next) => {
          setActivationToken('');
          setSession(next);
        }}
      />
    );
  }
  if (session?.authenticated && !session.demo && !workspaceAccess(session).hasFinancialAccess) {
    return <AccessPending api={api} session={session} onSession={setSession} />;
  }

  // Everything containing financial or editor state belongs to this identity.
  // Authentication, activation, and grant changes dispose of the old workspace.
  return <FinancialWorkspace key={workspaceIdentity(session)} session={session} onSession={setSession} />;
}
