import { ShieldCheck, RefreshCw, Download } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { IntegrationSettings } from '../../components/integration-settings';
import { SimplefinSettings } from '../../components/simplefin-settings';
import { AssistantSettings } from '../../components/assistant-settings';
import { UsersSettings } from '../../components/users-settings';
import { NotificationSettings } from '../../components/notification-settings';
import { ImportHealth } from '../../components/import-health';
import { api } from '../../lib/api.js';

export function SettingsPage({ data, session, month, currency, busy, mutate, onUpdated, onSession }) {
  return (
    <div className="settings-stack">
      <section className="card settings-card">
        <div className="card-heading">
          <div>
            <h2>Redbark connection</h2>
            <p>Manage encrypted credentials and import settings below. Test your saved connection before importing.</p>
          </div>
          <span className={`status-pill ${data.redbark?.verified ? 'connected' : ''}`}>
            {data.redbark?.verified
              ? 'Verified'
              : data.redbark?.configured
                ? 'Configured · unverified'
                : 'Not connected'}
          </span>
        </div>
        <dl>
          <div>
            <dt>Environment</dt>
            <dd>{session?.demo ? 'Demo · fictional fixtures' : 'Live · authenticated'}</dd>
          </div>
          <div>
            <dt>API version</dt>
            <dd>{data.redbark?.version || '2026-10-01.wattle'} · beta</dd>
          </div>
          <div>
            <dt>Signed event webhook</dt>
            <dd>{data.redbark?.webhookConfigured ? 'Configured' : 'Not configured'}</dd>
          </div>
          <div>
            <dt>Account discovery</dt>
            <dd>Every 4 hours</dd>
          </div>
          <div>
            <dt>Last poll</dt>
            <dd>{data.redbark?.lastPollAt ? new Date(data.redbark.lastPollAt).toLocaleString() : 'Not yet run'}</dd>
          </div>
        </dl>
        {data.redbark?.lastError && <div className="alert alert-error">{data.redbark.lastError}</div>}
        <div className="setup-note">
          <ShieldCheck size={20} />
          <div>
            <strong>Configure in Settings</strong>
            <p>
              Save your Redbark API key and API version below, then test your connection. Changes take effect without a
              restart. Register your signed event destination after its public callback is reachable. Never enter
              credentials into chat.
            </p>
          </div>
        </div>
        <Button disabled={busy || session?.demo} onClick={() => mutate('/connection/test', {})}>
          <RefreshCw size={16} className={busy ? 'spin' : ''} />
          Test connection
        </Button>
        {session?.demo && (
          <p className="footnote">Connection testing is available in live mode. See the deployment guide for setup.</p>
        )}
      </section>
      <IntegrationSettings api={api} demo={session?.demo} onUpdated={onUpdated} />
      <SimplefinSettings api={api} demo={session?.demo} onUpdated={onUpdated} />
      <AssistantSettings api={api} demo={session?.demo} />
      <UsersSettings api={api} session={session} onSession={onSession} />
      <NotificationSettings api={api} demo={session?.demo} />
      <ImportHealth api={api} demo={session?.demo} />
      <section className="card settings-card">
        <h2>Your data, always yours</h2>
        <p className="muted">
          Export this month's transactions as JSON with its report. Use PostgreSQL backups for a complete copy including
          original provider evidence and audit history.
        </p>
        <Button asChild variant="outline">
          <a href={`/api/export?month=${month}&currency=${currency}`}>
            <Download size={16} />
            Export {month}
          </a>
        </Button>
      </section>
    </div>
  );
}
