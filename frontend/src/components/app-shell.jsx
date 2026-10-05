import { useEffect, useRef, useState } from 'react';
import {
  LayoutDashboard,
  ArrowLeftRight,
  Wallet,
  PiggyBank,
  Settings,
  Inbox,
  SlidersHorizontal,
  KeyRound,
  LogOut,
  Menu,
  X
} from 'lucide-react';
import { GlobalSearch } from './global-search';
import { BrandMark } from './brand';
import { AssistantPanel } from './assistant-panel';
import { api } from '../lib/api.mjs';

const drawerQuery = '(max-width: 680px)';

// The drawer is off-canvas only at phone widths; there it must leave the tab order while closed.
function useDrawerMode() {
  const [drawer, setDrawer] = useState(() => matchMedia(drawerQuery).matches);
  useEffect(() => {
    const query = matchMedia(drawerQuery);
    const update = () => setDrawer(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return drawer;
}

const icons = {
  Overview: LayoutDashboard,
  Transactions: ArrowLeftRight,
  Accounts: Wallet,
  Budgets: PiggyBank,
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
  const initial = (session?.user?.name || 'Personal workspace').trim().charAt(0).toUpperCase();
  const drawer = useDrawerMode();
  const menuButton = useRef(null);
  const navigation = useRef(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (!drawer) {
      return undefined;
    }

    if (menu) {
      wasOpen.current = true;
      navigation.current?.querySelector('button')?.focus();
      const close = (event) => event.key === 'Escape' && setMenu(false);
      document.addEventListener('keydown', close);
      return () => document.removeEventListener('keydown', close);
    }

    if (wasOpen.current) {
      wasOpen.current = false;
      menuButton.current?.focus();
    }

    return undefined;
  }, [menu, drawer, setMenu]);
  return (
    <div className="app-shell">
      <aside className={`sidebar ${menu ? 'sidebar-open' : ''}`} inert={drawer && !menu}>
        <div className="sidebar-inner">
          <div className="brand-row">
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
            <button className="drawer-close" aria-label="Close menu" onClick={() => setMenu(false)}>
              <X size={20} />
            </button>
          </div>
          <nav id="workspace-navigation" ref={navigation} aria-label="Workspace">
            {Object.entries(icons)
              .filter(([name]) => canNavigate(name))
              .map(([name, Icon]) => (
                <button
                  key={name}
                  className={`nav-item ${page === name ? 'active' : ''}`}
                  aria-current={page === name ? 'page' : undefined}
                  onClick={() => navigate(name)}
                >
                  <Icon size={19} />
                  <span>{name}</span>
                </button>
              ))}
          </nav>
          <div className="sidebar-bottom">
            <div className="profile">
              <div className="profile-avatar" aria-hidden="true">
                {initial}
              </div>
              <div>
                <strong>{session?.user?.name || 'Personal workspace'}</strong>
                <small>{session?.demo ? 'Demo environment' : 'Self-hosted'}</small>
              </div>
              {!session?.demo && (
                <button aria-label="Change password" title="Change password" onClick={() => onChangePassword()}>
                  <KeyRound size={17} />
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
          <button
            ref={menuButton}
            className="mobile-menu"
            aria-label="Open menu"
            aria-expanded={menu}
            aria-controls="workspace-navigation"
            onClick={() => setMenu(!menu)}
          >
            <Menu size={21} />
          </button>
          <GlobalSearch canSearch={canSearch} activeSearch={activeSearch} routeKey={routeKey} onSearch={onSearch} />
          <div className="topbar-right">
            {hasFinancialAccess && <AssistantPanel api={api} session={session} onViewTransaction={onViewTransaction} />}
            {session?.demo && (
              <span className="demo-badge">
                <span />
                DEMO DATA
              </span>
            )}
          </div>
        </header>
        {children}
      </div>
      {dialogs}
    </div>
  );
}
