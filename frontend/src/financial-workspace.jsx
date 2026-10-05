import { ManualDialog } from './features/accounts/manual-dialog';
import { useEffect, useState } from 'react';
import { AlertCircle, ArrowRight, Check, RefreshCw, X, Info } from 'lucide-react';
import { api } from './lib/api.mjs';
import { reportQuery, reportingMonth } from './lib/report-query.mjs';
import { workspaceAccess } from './lib/workspace-access.mjs';
import { useWorkspaceData } from './hooks/use-workspace-data.mjs';
import { useTransactionFilters } from './hooks/use-transaction-filters.mjs';
import { useWorkspaceNavigation } from './hooks/use-workspace-navigation.mjs';
import {
  accountTransactionFilters,
  drilldownFilters,
  initialTransactionFilters
} from './features/transactions/transaction-model.mjs';
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
import { writeTransactionRoute } from './lib/transaction-route.mjs';
import { RulesPage, RuleDialog } from './features/rules/rules-page';
import { ruleFromTransaction } from './features/rules/rule-model.mjs';
import { SettingsPage } from './features/settings/settings-page';
import { setStampTimeZone } from './lib/dates.mjs';

export function FinancialWorkspace({ session, onSession }) {
  const { page, section, transactionQuery, changeRoute, confirmLeave, onDirtyChange } = useWorkspaceNavigation();
  const [selectedMonth, setMonth] = useState(() => reportingMonth(session));
  const [selectedCurrency, setCurrency] = useState(session?.currency || 'AUD');
  const [period, setPeriod] = useState(1);
  const [menu, setMenu] = useState(false);
  const [edit, setEdit] = useState(null);
  const [manual, setManual] = useState(null);
  const [accountEdit, setAccountEdit] = useState(null);
  const [changePassword, setChangePassword] = useState(false);
  const [budget, setBudget] = useState(null);
  const [rule, setRule] = useState(null);
  const { isAdmin, hasAccountAccess, hasBudgetAccess, hasFinancialAccess, canEditAccount, canNavigate } =
    workspaceAccess(session);
  // Every stamp below renders in the zone the footer prints.
  setStampTimeZone(session?.timeZone || 'Australia/Brisbane');
  const {
    filters,
    updateFilters,
    routeMonth: month,
    routeCurrency: currency
  } = useTransactionFilters(selectedMonth, selectedCurrency, { page, transactionQuery, changeRoute });
  const routeKey = `${page}/${section}/${transactionQuery || ''}`;
  useEffect(() => {
    setEdit(null);
    setAccountEdit(null);
    setManual(null);
    setBudget(null);
    setRule(null);
  }, [routeKey]);
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
      changeRoute(hasAccountAccess ? 'Overview' : 'Budgets', undefined, { replace: true, force: true });
    }
  }, [session, page, isAdmin, hasAccountAccess, hasBudgetAccess]);

  function navigate(next, nextSection) {
    if (!canNavigate(next)) {
      next = hasAccountAccess ? 'Overview' : 'Budgets';
    }

    if (next === page && (!nextSection || nextSection === section)) {
      if (!confirmLeave()) {
        return;
      }

      load();
      setMenu(false);
      return;
    }

    if (
      !changeRoute(
        next,
        nextSection,
        next === 'Transactions' ? { transactionQuery: writeTransactionRoute(filters, { month, currency }) } : {}
      )
    ) {
      return;
    }

    if (next !== page) {
      resetPage();
    }

    setMenu(false);
  }

  function openTransactions(nextFilters, controls = { month, currency }) {
    const query = writeTransactionRoute(nextFilters, controls);
    if (page === 'Transactions' && transactionQuery === query) {
      if (!confirmLeave()) {
        return false;
      }

      setEdit(null);
      setAccountEdit(null);
      setManual(null);
      setBudget(null);
      setRule(null);
      load();
      return true;
    }

    if (!changeRoute('Transactions', undefined, { transactionQuery: query })) {
      return false;
    }

    resetPage();
    setMenu(false);
    return true;
  }

  function globalSearch(search) {
    if (!hasAccountAccess) {
      return false;
    }

    return openTransactions(
      { ...initialTransactionFilters(), search, allHistory: true },
      { month: selectedMonth, currency: session?.currency || 'AUD' }
    );
  }

  function drill(selection = {}) {
    openTransactions(drilldownFilters(selection, { page, startDate: data.startDate, endDate: data.endDate }), {
      month: selection.month || month,
      currency
    });
  }

  function viewAccountTransactions(account) {
    openTransactions(accountTransactionFilters(account), { month, currency: account.currency });
  }

  function createRuleFromTransaction(transaction) {
    if (isAdmin) {
      setRule(ruleFromTransaction(transaction));
    }
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
      canSearch={hasAccountAccess}
      activeSearch={page === 'Transactions' ? filters.search : ''}
      routeKey={routeKey}
      onSearch={globalSearch}
      onChangePassword={() => setChangePassword(true)}
      onSignOut={async () => {
        if (!confirmLeave()) {
          return;
        }

        await api('/logout', { method: 'POST' });
        history.replaceState(history.state, '', '#overview');
        onSession({ authenticated: false });
      }}
      onViewTransaction={
        hasAccountAccess
          ? (id, sourceCurrency) => {
              openTransactions(drilldownFilters({ ids: [id], status: '' }, { page }), {
                month,
                currency: /^[A-Z]{3}$/.test(sourceCurrency || '') ? sourceCurrency : currency
              });
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
          <ManualDialog
            draft={manual}
            close={() => setManual(null)}
            saved={refreshCurrent}
            canEditAccount={canEditAccount}
            onDirtyChange={onDirtyChange}
            timeZone={session?.timeZone}
          />
          <AccountDialog
            onDirtyChange={onDirtyChange}
            account={accountEdit}
            close={() => setAccountEdit(null)}
            busy={busy}
            error={error}
            save={async (values) => {
              if (await mutate(`/accounts/${accountEdit.id}`, values, 'PATCH')) {
                setAccountEdit(null);
                setManual(null);
              }
            }}
          />
          <EditTransaction
            onDirtyChange={onDirtyChange}
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
            onDirtyChange={onDirtyChange}
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
            onDirtyChange={onDirtyChange}
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
          data={data}
          session={session}
          month={month}
          currency={currency}
          period={period}
          setPeriod={setPeriod}
          onMonthChange={(value) => {
            setMonth(value);
            updateFilters({ ids: null, allHistory: false, from: '', to: '' }, { month: value });
          }}
          onCurrencyChange={(value) => {
            setCurrency(value);
            updateFilters({ ids: null }, { currency: value });
          }}
        />
        {session?.demo && (
          <div className="demo-notice">
            <Info size={15} />
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
            <Button variant="outline" onClick={load}>
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
                canReview={canNavigate('Review')}
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
                onEdit={(t) => (t.manualEntryId ? setManual({ type: 'edit', entryId: t.manualEntryId }) : setEdit(t))}
                onCreateRule={createRuleFromTransaction}
                filters={filters}
                onFiltersChange={updateFilters}
              />
            )}
            {page === 'Accounts' && (
              <AccountsPage
                accounts={data.accounts || []}
                isAdmin={isAdmin}
                onManual={setManual}
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
              <ReviewsPage
                isAdmin={isAdmin}
                onCreateRule={createRuleFromTransaction}
                canEditAccount={canEditAccount}
                reviews={data.reviews || []}
                busy={busy}
                onEdit={(t) => (t.manualEntryId ? setManual({ type: 'edit', entryId: t.manualEntryId }) : setEdit(t))}
                onRefresh={refreshCurrent}
                onNotice={setNotice}
              />
            )}
            {page === 'Rules' && (
              <RulesPage
                rules={data.rules || []}
                onEdit={setRule}
                busy={busy}
                onDelete={(id) => mutate(`/rules/${id}`, undefined, 'DELETE')}
              />
            )}
            {page === 'Settings' && isAdmin && (
              <SettingsPage
                section={section}
                navigateSection={(nextSection) => navigate('Settings', nextSection)}
                onDirtyChange={onDirtyChange}
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
