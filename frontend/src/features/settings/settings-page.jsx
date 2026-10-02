import { AccountDataSettings } from './account-data-settings';
import { useLayoutEffect, useRef } from 'react';
import { Download } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { IntegrationSettings } from '../../components/integration-settings';
import { SimplefinSettings } from '../../components/simplefin-settings';
import { PocketSmithSettings } from './pocketsmith-settings';
import { BankFeedPanel } from './bank-feed-panel';
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
            {section === 'bank-feeds' && (
              <>
                <BankFeedPanel name="Redbark" description="Direct bank connection and signed events" open>
                  <IntegrationSettings api={api} demo={session?.demo} onUpdated={onUpdated} status={data.redbark} />
                </BankFeedPanel>
                <BankFeedPanel name="PocketSmith" description="Read-only import from your personal account">
                  <PocketSmithSettings api={api} demo={session?.demo} onUpdated={onUpdated} />
                </BankFeedPanel>
                <BankFeedPanel name="SimpleFIN" description="Read-only access through a supported provider">
                  <SimplefinSettings api={api} demo={session?.demo} onUpdated={onUpdated} />
                </BankFeedPanel>
              </>
            )}
            {section === 'categories' && <CategoriesSettings />}
            {section === 'members' && <UsersSettings api={api} session={session} onSession={onSession} />}
            {section === 'notifications' && <NotificationSettings api={api} demo={session?.demo} />}
            {section === 'ai' && <AiSettings api={api} demo={session?.demo} onUpdated={onUpdated} />}
            {section === 'data' && (
              <>
                <AccountDataSettings onUpdated={onUpdated} />
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
