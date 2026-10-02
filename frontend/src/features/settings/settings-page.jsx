import { AccountDataSettings } from './account-data-settings';
import { useLayoutEffect, useRef } from 'react';
import { ShieldCheck, RefreshCw, Download } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { IntegrationSettings } from '../../components/integration-settings';
import { SimplefinSettings } from '../../components/simplefin-settings';
import { CategoriesSettings } from './categories-settings';
import { AiSettings } from './ai-settings';
import { SettingsDrafts } from './settings-dirty';
import { settingsSections } from './settings-navigation.mjs';
import { UsersSettings } from '../../components/users-settings';
import { NotificationSettings } from '../../components/notification-settings';
import { ImportHealth } from '../../components/import-health';
import { api } from '../../lib/api.mjs';

export function SettingsPage({
  data,
  session,
  month,
  currency,
  busy,
  mutate,
  onUpdated,
  onSession,
  section,
  navigateSection,
  onDirtyChange
}) {
  const heading = useRef(null);
  const active = settingsSections.find((item) => item.id === section) || settingsSections[0];
  useLayoutEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, [section]);
  return (
    <div className="settings-layout">
      <nav className="settings-nav" aria-label="Settings sections">
        {settingsSections.map((item) => (
          <a
            key={item.id}
            href={`#settings/${item.id}`}
            aria-current={item.id === section ? 'page' : undefined}
            onClick={(event) => {
              if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
                return;
              }

              event.preventDefault();
              if (item.id !== section) {
                navigateSection(item.id);
              }
            }}
          >
            <span>{item.label}</span>
            <small>{item.description}</small>
          </a>
        ))}
      </nav>
      <div className="settings-content">
        <div className="settings-section-heading">
          <h2 tabIndex={-1} ref={heading}>
            {active.label}
          </h2>
          <p>{active.description}</p>
        </div>
        <SettingsDrafts key={section} onDirtyChange={onDirtyChange}>
          <div className="settings-stack">
            {section === 'redbark' && (
              <>
                <section className="card settings-card">
                  <div className="card-heading">
                    <div>
                      <h2>Redbark connection</h2>
                      <p>
                        Manage encrypted credentials and import settings below. Test your saved connection before
                        importing.
                      </p>
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
                      <dd>
                        {data.redbark?.lastPollAt ? new Date(data.redbark.lastPollAt).toLocaleString() : 'Not yet run'}
                      </dd>
                    </div>
                  </dl>
                  {data.redbark?.lastError && <div className="alert alert-error">{data.redbark.lastError}</div>}
                  <div className="setup-note">
                    <ShieldCheck size={20} />
                    <div>
                      <strong>Your RedBark connection</strong>
                      <p>
                        Save your Redbark API key and API version below, then test your connection. Changes take effect
                        without a restart. Register your signed event destination after its public callback is
                        reachable. Never enter credentials into chat.
                      </p>
                    </div>
                  </div>
                  <Button disabled={busy || session?.demo} onClick={() => mutate('/connection/test', {})}>
                    <RefreshCw size={16} className={busy ? 'spin' : ''} />
                    Test connection
                  </Button>
                  {session?.demo && (
                    <p className="footnote">
                      Connection testing is available in live mode. See the deployment guide for setup.
                    </p>
                  )}
                </section>
                <IntegrationSettings api={api} demo={session?.demo} onUpdated={onUpdated} />
              </>
            )}
            {section === 'categories' && <CategoriesSettings />}
            {section === 'members' && <UsersSettings api={api} session={session} onSession={onSession} />}
            {section === 'notifications' && <NotificationSettings api={api} demo={session?.demo} />}
            {section === 'ai' && <AiSettings api={api} demo={session?.demo} onUpdated={onUpdated} />}
            {section === 'data' && (
              <>
                <AccountDataSettings onUpdated={onUpdated} />
                <SimplefinSettings api={api} demo={session?.demo} onUpdated={onUpdated} />
                <ImportHealth api={api} demo={session?.demo} />
                <section className="card settings-card">
                  <h2>Your data, always yours</h2>
                  <p className="muted">
                    Export this month's transactions as JSON with its report. Use PostgreSQL backups for a complete copy
                    including original provider evidence and audit history.
                  </p>
                  <Button asChild variant="outline">
                    <a href={`/api/export?month=${month}&currency=${currency}`}>
                      <Download size={16} />
                      Export {month}
                    </a>
                  </Button>
                </section>
              </>
            )}
          </div>
        </SettingsDrafts>
      </div>
    </div>
  );
}
