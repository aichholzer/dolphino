import {
  LayoutDashboard,
  ArrowLeftRight,
  Wallet,
  ChartNoAxesCombined,
  Settings,
  Inbox,
  SlidersHorizontal,
  ShieldCheck,
  LogOut,
  Menu,
  ChevronRight
} from 'lucide-react';
import { GlobalSearch } from './global-search';
import { BrandMark } from './brand';
import { AssistantPanel } from './assistant-panel';
import { api } from '../lib/api.mjs';

const icons = {
  Overview: LayoutDashboard,
  Transactions: ArrowLeftRight,
  Accounts: Wallet,
  Budgets: ChartNoAxesCombined,
  Review: Inbox,
  Rules: SlidersHorizontal,
  Settings
};

export function AppShell({
  page,
  session,
  menu,
  setMenu,
  navigate,
  canNavigate,
  hasFinancialAccess,
  canSearch,
  activeSearch,
  routeKey,
  onSearch,
  onChangePassword,
  onSignOut,
  onViewTransaction,
  children,
  dialogs
}) {
  return (
    <div className="app-shell">
      <aside className={`sidebar ${menu ? 'sidebar-open' : ''}`}>
        <div className="sidebar-inner">
          <a
            className="brand"
            href="#"
            onClick={(e) => {
              e.preventDefault();
              navigate('Overview');
            }}
          >
            <BrandMark />
          </a>
          <div className="workspace">
            <div className="workspace-avatar">S</div>
            <div>
              <strong>My personal finances</strong>
              <small>Your space. Your pace.</small>
            </div>
          </div>
          <div className="nav-label">WORKSPACE</div>
          <nav>
            {Object.entries(icons)
              .filter(([name]) => canNavigate(name))
              .map(([name, Icon]) => (
                <button
                  key={name}
                  className={`nav-item ${page === name ? 'active' : ''}`}
                  onClick={() => navigate(name)}
                >
                  <Icon size={19} />
                  <span>{name}</span>
                  {name === 'Overview' && <span className="nav-active-dot" />}
                </button>
              ))}
          </nav>
          <div className="sidebar-bottom">
            <div className="privacy">
              <ShieldCheck size={19} />
              <div>
                <strong>Financially yours.</strong>
                <p>
                  Private by design.
                  <br />
                  At home on your own server.
                </p>
              </div>
            </div>
            <div className="profile">
              <div className="profile-avatar">S</div>
              <div>
                <strong>{session?.user?.name || 'Personal workspace'}</strong>
                <small>{session?.demo ? 'Demo environment' : 'Self-hosted'}</small>
              </div>
              {!session?.demo && (
                <button aria-label="Change password" title="Change password" onClick={() => onChangePassword()}>
                  <ShieldCheck size={17} />
                </button>
              )}
              {!session?.demo && (
                <button aria-label="Sign out" onClick={onSignOut}>
                  <LogOut size={17} />
                </button>
              )}
            </div>
          </div>
        </div>
      </aside>
      {menu && <div className="mobile-overlay" onClick={() => setMenu(false)} />}
      <div className="main-shell">
        <header className="topbar">
          <button className="mobile-menu" aria-label="Open menu" onClick={() => setMenu(!menu)}>
            <Menu size={21} />
          </button>
          <div className="breadcrumb">
            <span className="header-brand">
              <img src="/dolphino.svg" alt="" aria-hidden="true" />
              dolphino
            </span>{' '}
            <ChevronRight size={14} />
            <span>{page}</span>
          </div>
          <GlobalSearch canSearch={canSearch} activeSearch={activeSearch} routeKey={routeKey} onSearch={onSearch} />
          <div className="topbar-right">
            {hasFinancialAccess && <AssistantPanel api={api} session={session} onViewTransaction={onViewTransaction} />}
            {session?.demo && (
              <span className="demo-badge">
                <span />
                DEMO DATA
              </span>
            )}
            <span className="private-label">
              <ShieldCheck size={14} />
              Private workspace
            </span>
          </div>
        </header>
        {children}
      </div>
      {dialogs}
    </div>
  );
}
