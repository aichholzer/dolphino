import { useEffect, useState } from 'react';
import { AlertCircle, ArrowRight, Check, RefreshCw, Sparkles, X } from 'lucide-react';
import { api } from './lib/api.js';
import { reportQuery, reportingMonth } from './lib/report-query.js';
import { workspaceAccess } from './lib/workspace-access.js';
import { useWorkspaceData } from './hooks/use-workspace-data.js';
import { useTransactionFilters } from './hooks/use-transaction-filters.js';
import { accountTransactionFilters, drilldownFilters } from './features/transactions/transaction-model.js';
import { AppShell } from './components/app-shell';
import { PageHeading } from './components/page-heading';
import { Empty } from './components/empty-state';
import { Button } from './components/ui/button';
import { Dialog } from './components/ui/dialog';
import { PasswordForm } from './components/auth';
import { OverviewPage } from './features/overview/overview-page';
import { TransactionsPage } from './features/transactions/transactions-page';
import { EditTransaction } from './features/transactions/transaction-dialog';
import { AccountsPage } from './features/accounts/accounts-page';
import { AccountDialog } from './features/accounts/account-dialog';
import { BudgetsPage } from './features/budgets/budgets-page';
import { BudgetDialog } from './features/budgets/budget-dialog';
import { ReviewsPage } from './features/reviews/reviews-page';
import { RulesPage, RuleDialog } from './features/rules/rules-page';
import { SettingsPage } from './features/settings/settings-page';

export function FinancialWorkspace({ session, onSession }) {
  const [page, setPage] = useState('Overview');
  const [month, setMonth] = useState(() => reportingMonth(session));
  const [currency, setCurrency] = useState(session?.currency || 'AUD');
  const [period, setPeriod] = useState(1);
  const [menu, setMenu] = useState(false);
  const [edit, setEdit] = useState(null);
  const [accountEdit, setAccountEdit] = useState(null);
  const [changePassword, setChangePassword] = useState(false);
  const [budget, setBudget] = useState(null);
  const [rule, setRule] = useState(null);
  const { isAdmin, hasAccountAccess, hasBudgetAccess, hasFinancialAccess, canEditAccount, canNavigate } =
    workspaceAccess(session);
  const { filters, updateFilters } = useTransactionFilters(month, currency);
  const query = reportQuery({ page, month, currency, period, filters });
  const { data, loading, error, notice, setNotice, busy, load, mutate, resetPage, refreshCurrent } = useWorkspaceData({
    session,
    onSession,
    page,
    query,
    search: filters.search
  });

  useEffect(() => {
    if (session?.authenticated && !isAdmin && !canNavigate(page)) {
      setPage(hasAccountAccess ? 'Overview' : 'Budgets');
    }
  }, [session, page, isAdmin, hasAccountAccess, hasBudgetAccess]);

  function navigate(next) {
    if (!canNavigate(next)) {
      next = hasAccountAccess ? 'Overview' : 'Budgets';
    }
    if (next === page) {
      load();
      setMenu(false);
      return;
    }
    resetPage();
    setPage(next);
    setMenu(false);
  }

  function drill(selection = {}) {
    updateFilters(drilldownFilters(selection, { page, startDate: data.startDate, endDate: data.endDate }));
    if (selection.month) {
      setMonth(selection.month);
    }
    navigate('Transactions');
  }

  function viewAccountTransactions(account) {
    updateFilters(accountTransactionFilters(account));
    setCurrency(account.currency);
    navigate('Transactions');
  }

  return (
    <AppShell
      page={page}
      session={session}
      menu={menu}
      setMenu={setMenu}
      navigate={navigate}
      canNavigate={canNavigate}
      hasFinancialAccess={hasFinancialAccess}
      onChangePassword={() => setChangePassword(true)}
      onSignOut={async () => {
        await api('/logout', { method: 'POST' });
        onSession({ authenticated: false });
      }}
      onViewTransaction={
        hasAccountAccess
          ? (id, sourceCurrency) => {
              if (/^[A-Z]{3}$/.test(sourceCurrency || '')) {
                setCurrency(sourceCurrency);
              }
              drill({ ids: [id], status: '' });
            }
          : undefined
      }
      dialogs={
        <>
          <Dialog
            open={changePassword}
            onOpenChange={setChangePassword}
            title="Your account"
            description={session?.user?.email}
          >
            <PasswordForm
              api={api}
              onChanged={() => {
                setChangePassword(false);
                onSession({ authenticated: false });
              }}
            />
          </Dialog>
          <AccountDialog
            account={accountEdit}
            close={() => setAccountEdit(null)}
            busy={busy}
            error={error}
            save={async (values) => {
              if (await mutate(`/accounts/${accountEdit.id}`, values, 'PATCH')) {
                setAccountEdit(null);
              }
            }}
          />
          <EditTransaction
            canSuggest={isAdmin}
            transaction={edit}
            open={!!edit}
            close={() => setEdit(null)}
            busy={busy}
            serverError={error}
            save={async (values) => {
              if (await mutate(`/transactions/${edit.id}`, values, 'PATCH')) {
                setEdit(null);
              }
            }}
          />
          <BudgetDialog
            canChangeCategory={isAdmin}
            currency={currency}
            budget={budget}
            close={() => setBudget(null)}
            busy={busy}
            serverError={error}
            save={async (values) => {
              if (await mutate('/budgets', { ...values, month, currency }, 'PUT')) {
                setBudget(null);
              }
            }}
          />
          <RuleDialog
            rule={rule}
            close={() => setRule(null)}
            busy={busy}
            serverError={error}
            save={async (values) => {
              if (await mutate('/rules', values)) {
                setRule(null);
              }
            }}
          />
        </>
      }
    >
      <main>
        <PageHeading
          page={page}
          session={session}
          month={month}
          currency={currency}
          period={period}
          setPeriod={setPeriod}
          onMonthChange={(value) => {
            setMonth(value);
            updateFilters({ ids: null, allHistory: false, from: '', to: '' });
          }}
          onCurrencyChange={(value) => {
            setCurrency(value);
            updateFilters({ ids: null });
          }}
        />
        {session?.demo && (
          <div className="demo-notice">
            <Sparkles size={15} />
            <span>You're exploring dolphino with fictional demo data. No bank connection is active.</span>
            <button onClick={() => navigate('Settings')}>
              Connection setup <ArrowRight size={14} />
            </button>
          </div>
        )}
        {error && (
          <div role="alert" className="alert alert-error">
            <AlertCircle size={18} />
            <span>{error}</span>
            <Button variant="ghost" size="sm" onClick={load}>
              Try again
            </Button>
          </div>
        )}
        {notice && (
          <div role="status" className="alert alert-success">
            <Check size={17} />
            {notice}
            <button aria-label="Dismiss notification" onClick={() => setNotice('')}>
              <X size={16} />
            </button>
          </div>
        )}
        {loading ? (
          <div className="loading">
            <RefreshCw size={22} className="spin" />
            Getting your financial picture…
          </div>
        ) : error && !Object.keys(data).length ? (
          <Empty
            title="Your data could not be loaded"
            detail="Use Try again above when the service is available. No financial totals are shown until the request succeeds."
            icon={AlertCircle}
          />
        ) : (
          <>
            {page === 'Overview' && (
              <OverviewPage
                data={data}
                isAdmin={isAdmin}
                month={month}
                period={period}
                currency={currency}
                navigate={navigate}
                drill={drill}
              />
            )}
            {page === 'Transactions' && (
              <TransactionsPage
                data={data}
                currency={currency}
                query={query}
                isAdmin={isAdmin}
                navigate={navigate}
                canEditAccount={canEditAccount}
                onEdit={setEdit}
                filters={filters}
                onFiltersChange={updateFilters}
              />
            )}
            {page === 'Accounts' && (
              <AccountsPage
                accounts={data.accounts || []}
                canEditAccount={canEditAccount}
                onEdit={setAccountEdit}
                onViewTransactions={viewAccountTransactions}
              />
            )}
            {page === 'Budgets' && (
              <BudgetsPage
                data={data}
                isAdmin={isAdmin}
                month={month}
                currency={currency}
                onEdit={setBudget}
                drill={drill}
              />
            )}
            {page === 'Review' && (
              <ReviewsPage reviews={data.reviews || []} busy={busy} onEdit={setEdit} mutate={mutate} />
            )}
            {page === 'Rules' && <RulesPage rules={data.rules || []} onEdit={setRule} />}
            {page === 'Settings' && (
              <SettingsPage
                data={data}
                session={session}
                month={month}
                currency={currency}
                busy={busy}
                mutate={mutate}
                onSession={onSession}
                onUpdated={refreshCurrent}
              />
            )}
          </>
        )}
        <footer className="page-footer">
          <span>
            dolphino<span className="brand-dot">.</span>{' '}
            <span className="footer-copy">A little more clarity. A little less worry.</span>
          </span>
          <span>
            {currency} · {session?.timeZone || 'Australia/Brisbane'}
          </span>
        </footer>
      </main>
    </AppShell>
  );
}
