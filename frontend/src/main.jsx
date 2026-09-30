import React, { useState, useEffect, useCallback, useRef } from "react";
import { createRoot } from "react-dom/client";
import {
  LayoutDashboard,
  ArrowLeftRight,
  Wallet,
  ChartNoAxesCombined,
  Settings,
  Search,
  ChevronRight,
  ArrowUpRight,
  ArrowDownLeft,
  Download,
  Plus,
  Check,
  RefreshCw,
  ShieldCheck,
  AlertCircle,
  SlidersHorizontal,
  LogOut,
  Menu,
  X,
  Sparkles,
  Landmark,
  ArrowRight,
  Clock,
  Inbox,
} from "lucide-react";
import { Button } from "./components/ui/button";
import { Dialog } from "./components/ui/dialog";
import "./style.css";
import { money, decimalToMinor, minorToDecimal } from "./money.js";
const CATEGORIES = [
  "Uncategorized",
  "Groceries",
  "Dining",
  "Transport",
  "Shopping",
  "Housing",
  "Utilities",
  "Health",
  "Entertainment",
  "Income",
  "Other",
];
const icons = {
  Overview: LayoutDashboard,
  Transactions: ArrowLeftRight,
  Accounts: Wallet,
  Budgets: ChartNoAxesCombined,
  Review: Inbox,
  Rules: SlidersHorizontal,
  Settings,
};
async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    credentials: "same-origin",
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(
      data.error?.message ||
        data.error ||
        data.message ||
        `Request failed (${response.status})`,
    );
  return data;
}
function App() {
  const requestId = useRef(0);
  const [session, setSession] = useState(null),
    [page, setPage] = useState("Overview"),
    [month, setMonth] = useState(new Date().toISOString().slice(0, 7)),
    [currency, setCurrency] = useState("AUD"),
    [data, setData] = useState({}),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [menu, setMenu] = useState(false),
    [search, setSearch] = useState(""),
    [category, setCategory] = useState(""),
    [status, setStatus] = useState(""),
    [kind, setKind] = useState(""),
    [ids, setIds] = useState(null),
    [edit, setEdit] = useState(null),
    [budget, setBudget] = useState(null),
    [rule, setRule] = useState(null),
    [busy, setBusy] = useState(false);
  const query = new URLSearchParams({
    month,
    currency,
    ...(search ? { search } : {}),
    ...(category ? { category } : {}),
    ...(status ? { status } : {}),
    ...(kind ? { kind } : {}),
    ...(ids !== null ? { ids: ids.join(",") } : {}),
  }).toString();
  useEffect(() => {
    api("/session")
      .then((s) => {
        setSession(s);
        setCurrency(s.currency || "AUD");
        const parts = new Intl.DateTimeFormat("en-CA", {
          timeZone: s.timeZone || "Australia/Brisbane",
          year: "numeric",
          month: "2-digit",
        }).formatToParts(new Date());
        setMonth(
          `${parts.find((p) => p.type === "year").value}-${parts.find((p) => p.type === "month").value}`,
        );
      })
      .catch((e) => {
        setError(e.message);
        setLoading(false);
      });
  }, []);
  const load = useCallback(async () => {
    if (!session) {
      try {
        setSession(await api("/session"));
      } catch (e) {
        setError(e.message);
      }
      return;
    }
    if (!session.authenticated && !session.demo) return;
    const activeRequest = ++requestId.current;
    setLoading(true);
    setError("");
    try {
      const path =
        page === "Overview"
          ? `/dashboard?${query}`
          : page === "Transactions"
            ? `/transactions?${query}`
            : page === "Accounts"
              ? "/accounts"
              : page === "Budgets"
                ? `/budgets?${query}`
                : page === "Review"
                  ? "/reviews"
                  : page === "Rules"
                    ? "/rules"
                    : "/settings";
      const result = await api(path);
      if (activeRequest === requestId.current) setData(result);
    } catch (e) {
      if (activeRequest === requestId.current) setError(e.message);
    } finally {
      if (activeRequest === requestId.current) setLoading(false);
    }
  }, [session, page, query]);
  useEffect(() => {
    const timer = setTimeout(load, search ? 220 : 0);
    return () => clearTimeout(timer);
  }, [load]);
  function navigate(next) {
    if (next === page) {
      load();
      setMenu(false);
      return;
    }
    requestId.current++;
    setLoading(true);
    setPage(next);
    setMenu(false);
    setError("");
    setNotice("");
    setData({});
  }
  async function mutate(path, body, method = "POST") {
    setBusy(true);
    setError("");
    try {
      const result = await api(path, { method, body: JSON.stringify(body) });
      setNotice(result.message || "Changes saved.");
      await load();
      return true;
    } catch (e) {
      setError(e.message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  function drill(filters = {}) {
    setSearch("");
    setIds(filters.ids ?? null);
    setCategory(filters.category || "");
    setKind(filters.kind || "");
    setStatus(filters.status || "posted");
    navigate("Transactions");
  }
  if (session && !session.authenticated && !session.demo)
    return <Login onLogin={setSession} />;
  const transactions = data.transactions || [],
    accounts = data.accounts || [],
    budgets = data.budgets || [],
    reviews = data.reviews || [],
    rules = data.rules || [];
  return (
    <div className="app-shell">
      <aside className={`sidebar ${menu ? "sidebar-open" : ""}`}>
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            navigate("Overview");
          }}
        >
          <div className="brand-symbol">
            <span />
            <span />
            <span />
          </div>
          profe<span className="brand-dot">.</span>
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
          {Object.entries(icons).map(([name, Icon]) => (
            <button
              key={name}
              className={`nav-item ${page === name ? "active" : ""}`}
              onClick={() => navigate(name)}
            >
              <Icon size={19} />
              <span>{name}</span>
              {name === "Overview" && <span className="nav-active-dot" />}
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
              <strong>Personal workspace</strong>
              <small>
                {session?.demo ? "Demo environment" : "Self-hosted"}
              </small>
            </div>
            {!session?.demo && (
              <button
                aria-label="Sign out"
                onClick={async () => {
                  await api("/logout", { method: "POST" });
                  setSession({ authenticated: false });
                }}
              >
                <LogOut size={17} />
              </button>
            )}
          </div>
        </div>
      </aside>
      {menu && (
        <div className="mobile-overlay" onClick={() => setMenu(false)} />
      )}
      <div className="main-shell">
        <header className="topbar">
          <button
            className="mobile-menu"
            aria-label="Open menu"
            onClick={() => setMenu(!menu)}
          >
            <Menu size={21} />
          </button>
          <div className="breadcrumb">
            Workspace <ChevronRight size={14} />
            <span>{page}</span>
          </div>
          <div className="topbar-right">
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
        <main>
          <div className="page-heading">
            <div>
              <div className="eyebrow">A LITTLE MORE CLARITY</div>
              <h1>
                {page === "Overview"
                  ? "Your money, at a glance."
                  : page === "Transactions"
                    ? "Every little detail."
                    : page === "Accounts"
                      ? "All your accounts."
                      : page === "Budgets"
                        ? "Make room for what matters."
                        : page === "Review"
                          ? "A second look."
                          : page === "Rules"
                            ? "Less sorting. More living."
                            : "Your workspace, your way."}
              </h1>
              <p>
                {
                  {
                    Overview:
                      "A clear picture of where you stand and where your money goes.",
                    Transactions:
                      "Search, organize, and make sense of every transaction.",
                    Accounts:
                      "Balances from your bank, with freshness you can see.",
                    Budgets:
                      "Simple monthly limits to keep your priorities in focus.",
                    Review:
                      "Resolve uncertainty before it becomes part of your picture.",
                    Rules: "Consistent categories, automatically applied.",
                    Settings:
                      "Manage your connection and keep your data in your hands.",
                  }[page]
                }
              </p>
            </div>
            {["Overview", "Transactions", "Budgets"].includes(page) && (
              <div className="period-controls">
                <label className="sr-only" htmlFor="month">
                  Reporting month
                </label>
                <input
                  id="month"
                  type="month"
                  value={month}
                  onChange={(e) => (setMonth(e.target.value), setIds(null))}
                />
                <select
                  aria-label="Reporting currency"
                  value={currency}
                  onChange={(e) => (setCurrency(e.target.value), setIds(null))}
                >
                  {[
                    ...new Set([
                      session?.currency || "AUD",
                      "AUD",
                      "USD",
                      "EUR",
                      "GBP",
                      "NZD",
                    ]),
                  ].map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </div>
            )}
          </div>
          {session?.demo && (
            <div className="demo-notice">
              <Sparkles size={15} />
              <span>
                You're exploring Profe with fictional demo data. No bank
                connection is active.
              </span>
              <button onClick={() => navigate("Settings")}>
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
              <button
                aria-label="Dismiss notification"
                onClick={() => setNotice("")}
              >
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
              {page === "Overview" && (
                <>
                  {data.alerts?.length > 0 && (
                    <div className="budget-alerts">
                      {data.alerts.map((a, i) => (
                        <button key={i} onClick={() => navigate("Budgets")}>
                          <AlertCircle size={14} />
                          {a.message} · {money(a.amountMinor, currency)}
                          <ChevronRight size={13} />
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="metric-grid">
                    <Metric
                      title="Total income"
                      value={money(data.incomeMinor, currency)}
                      subtitle="Posted income this month"
                      icon={ArrowDownLeft}
                      color="green"
                      onClick={() =>
                        drill({ ids: data.transactionIds?.income })
                      }
                    />
                    <Metric
                      title="Total spending"
                      value={money(data.expensesMinor, currency)}
                      subtitle="Transfers excluded · refunds included"
                      icon={ArrowUpRight}
                      color="orange"
                      onClick={() =>
                        drill({ ids: data.transactionIds?.expenses })
                      }
                    />
                    <Metric
                      title="Net cash flow"
                      value={money(data.netMinor, currency)}
                      subtitle="Income minus spending"
                      icon={ChartNoAxesCombined}
                      color="purple"
                      onClick={() =>
                        drill({
                          ids: [
                            ...(data.transactionIds?.income || []),
                            ...(data.transactionIds?.expenses || []),
                          ],
                        })
                      }
                    />
                  </div>
                  <div className="chart-grid">
                    <section className="card">
                      <div className="card-heading">
                        <div>
                          <h2>Money in, money out</h2>
                          <p>Daily activity · striped bars are net refunds</p>
                        </div>
                        <div className="legend">
                          <span className="legend-income" />
                          Income
                          <span className="legend-expense" />
                          Spending
                        </div>
                      </div>
                      <CashChart rows={data.trend || []} currency={currency} />
                    </section>
                    <section className="card">
                      <div className="card-heading">
                        <div>
                          <h2>Where it went</h2>
                          <p>Posted spending by category</p>
                        </div>
                        <button
                          className="icon-link"
                          aria-label="View all spending"
                          onClick={() =>
                            drill({ ids: data.transactionIds?.expenses })
                          }
                        >
                          <ArrowUpRight size={20} />
                        </button>
                      </div>
                      <CategoryChart
                        rows={data.categories || []}
                        currency={currency}
                        onSelect={(category) =>
                          drill({
                            category,
                            ids: data.categories?.find(
                              (c) => c.category === category,
                            )?.transactionIds,
                          })
                        }
                      />
                    </section>
                  </div>
                  <div className="overview-bottom">
                    <section className="card coverage-card">
                      <div className="coverage-icon">
                        <ShieldCheck size={24} />
                      </div>
                      <div>
                        <h2>A picture you can trust</h2>
                        <p>
                          {data.coverage?.reason ||
                            "Totals include imported posted transactions for this month and currency. Bank balances are separate snapshots."}
                        </p>
                        <div className="coverage-meta">
                          <span>
                            <Clock size={13} />
                            {data.coverage?.fetchedAt
                              ? `Updated ${new Date(data.coverage.fetchedAt).toLocaleString()}`
                              : "Freshness depends on your bank connection"}
                          </span>
                          <button onClick={() => navigate("Accounts")}>
                            View coverage <ArrowRight size={13} />
                          </button>
                        </div>
                      </div>
                    </section>
                    <section className="card pending-card">
                      <span className="label">PENDING TRANSACTIONS</span>
                      <strong>{money(data.pendingMinor, currency)}</strong>
                      <p>Shown separately until posted.</p>
                      <button onClick={() => drill({ status: "pending" })}>
                        See pending <ArrowRight size={14} />
                      </button>
                    </section>
                  </div>
                </>
              )}
              {page === "Transactions" && (
                <section className="card transactions-card">
                  <div className="table-toolbar">
                    <div className="search-input">
                      <Search size={17} />
                      <input
                        aria-label="Search transactions"
                        placeholder="Search transactions…"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                      />
                    </div>
                    <select
                      aria-label="Filter category"
                      value={category}
                      onChange={(e) => setCategory(e.target.value)}
                    >
                      <option value="">All categories</option>
                      {CATEGORIES.map((c) => (
                        <option key={c}>{c}</option>
                      ))}
                    </select>
                    <select
                      aria-label="Filter status"
                      value={status}
                      onChange={(e) => setStatus(e.target.value)}
                    >
                      <option value="">All statuses</option>
                      <option value="posted">Posted</option>
                      <option value="pending">Pending</option>
                    </select>
                    <select
                      aria-label="Filter type"
                      value={kind}
                      onChange={(e) => setKind(e.target.value)}
                    >
                      <option value="">All types</option>
                      {["expense", "income", "transfer", "refund"].map((k) => (
                        <option key={k}>{k}</option>
                      ))}
                    </select>
                    <Button asChild variant="outline">
                      <a href={`/api/export?${query}`}>
                        <Download size={15} />
                        Export
                      </a>
                    </Button>
                  </div>
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Transaction</th>
                          <th>Date</th>
                          <th>Category</th>
                          <th>Account</th>
                          <th className="align-right">Amount</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {transactions.map((t) => (
                          <tr key={t.id}>
                            <td>
                              <div className="transaction-name">
                                <div
                                  className={`transaction-icon ${t.kind === "income" ? "green" : ""}`}
                                >
                                  {t.kind === "income" ? (
                                    <ArrowDownLeft size={17} />
                                  ) : (
                                    <ArrowUpRight size={17} />
                                  )}
                                </div>
                                <div>
                                  <strong>{t.description}</strong>
                                  <small>
                                    {t.status === "pending"
                                      ? "Pending · excluded from actuals"
                                      : t.kind || "expense"}
                                    {t.reviewReason ? " · Needs review" : ""}
                                  </small>
                                </div>
                              </div>
                            </td>
                            <td>{String(t.date || "").slice(0, 10)}</td>
                            <td>
                              <span className="category-tag">
                                {t.splits?.length > 1
                                  ? "Split transaction"
                                  : t.category || "Uncategorized"}
                              </span>
                            </td>
                            <td className="muted">{t.accountName || "—"}</td>
                            <td
                              className={`align-right amount ${BigInt(t.amountMinor || 0) > 0n ? "positive" : ""}`}
                            >
                              {money(t.amountMinor, t.currency)}
                            </td>
                            <td>
                              <Button
                                size="sm"
                                variant="ghost"
                                aria-label={`Edit ${t.description}`}
                                onClick={() => setEdit(t)}
                              >
                                Edit
                              </Button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {ids !== null && (
                    <div className="table-footer">
                      Showing transactions contributing to the selected total.{" "}
                      <button
                        onClick={() => {
                          setIds(null);
                          setCategory("");
                          setKind("");
                          setStatus("");
                        }}
                      >
                        Clear drilldown
                      </button>
                    </div>
                  )}
                  {!transactions.length && (
                    <Empty
                      title="No transactions here yet"
                      detail="Try another month or adjust your filters."
                    />
                  )}
                  <div className="table-footer">
                    {transactions.length} transactions · {currency} · Posted
                    actuals use transaction date
                  </div>
                </section>
              )}
              {page === "Accounts" && (
                <>
                  <div className="account-grid">
                    {accounts.map((a) => (
                      <section className="card account-card" key={a.id}>
                        <div className="account-heading">
                          <div className="bank-icon">
                            <Landmark size={24} />
                          </div>
                          <span className="category-tag">{a.currency}</span>
                        </div>
                        <h2>{a.name}</h2>
                        <p>{a.institution || "Connected account"}</p>
                        <div className="account-balance">
                          {a.balanceMinor == null
                            ? "—"
                            : money(a.balanceMinor, a.currency)}
                        </div>
                        <div className="account-meta">
                          <span>
                            {a.balanceType || "Reported"} balance ·{" "}
                            {a.balanceAt
                              ? new Date(a.balanceAt).toLocaleString()
                              : "No balance timestamp"}
                          </span>
                          <span>
                            <Clock size={14} />
                            {a.fetchedAt
                              ? new Date(a.fetchedAt).toLocaleString()
                              : "Not yet synced"}
                          </span>
                          <span>
                            {a.reconciliationReason ||
                              "Not reconciled: no compatible balance coverage."}
                          </span>
                        </div>
                      </section>
                    ))}
                  </div>
                  {!accounts.length && (
                    <Empty
                      title="No accounts yet"
                      detail="Configure Redbark in your server environment, then test the connection in Settings."
                    />
                  )}
                  <p className="footnote">
                    Bank balances are provider snapshots. They do not prove the
                    accuracy of imported transaction totals. Account discovery
                    runs every four hours.
                  </p>
                </>
              )}
              {page === "Budgets" && (
                <>
                  {data.alerts?.map((a, i) => (
                    <div key={i} role="status" className="alert budget-alert">
                      <AlertCircle size={16} />
                      {a.message} · {money(a.amountMinor, currency)}
                    </div>
                  ))}
                  <div className="section-toolbar">
                    <p>
                      Category caps · {month} · {currency}
                    </p>
                    <Button
                      onClick={() =>
                        setBudget({
                          category: "Groceries",
                          capMinor: "50000",
                          rolloverEnabled: false,
                        })
                      }
                    >
                      <Plus size={16} />
                      Add budget
                    </Button>
                  </div>
                  <div className="budget-grid">
                    {budgets.map((b) => {
                      const over = BigInt(b.remainingMinor || 0) < 0n;
                      const ratio = Math.min(
                        100,
                        Math.max(
                          0,
                          (Number(b.spentMinor || 0) /
                            Math.max(1, Number(b.availableMinor || 0))) *
                            100,
                        ),
                      );
                      return (
                        <section className="card budget-card" key={b.category}>
                          <div className="card-heading">
                            <h2>{b.category}</h2>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setBudget(b)}
                            >
                              Edit
                            </Button>
                          </div>
                          <div className="budget-amount">
                            {money(b.spentMinor, currency)}
                            <span>
                              {" "}
                              / {money(b.availableMinor, currency)} allowance
                            </span>
                          </div>
                          <div
                            className={`progress-track ${over ? "over" : ""}`}
                          >
                            <div style={{ width: `${ratio}%` }} />
                          </div>
                          <div className="budget-status">
                            <span className={over ? "negative" : "muted"}>
                              {over ? "Over budget by " : ""}
                              {money(
                                over
                                  ? (-BigInt(b.remainingMinor)).toString()
                                  : b.remainingMinor,
                                currency,
                              )}
                              {!over ? " available" : ""}
                            </span>
                            {b.rolloverEnabled && (
                              <span className="category-tag">Rollover on</span>
                            )}
                          </div>
                          <div className="budget-footer">
                            <span>
                              Rollover: {money(b.rolloverMinor, currency)}
                            </span>
                            <button
                              onClick={() =>
                                drill({
                                  category: b.category,
                                  ids: b.transactionIds,
                                })
                              }
                            >
                              View spending <ArrowRight size={13} />
                            </button>
                          </div>
                        </section>
                      );
                    })}
                  </div>
                  {!budgets.length && (
                    <Empty
                      title="A plan for your priorities"
                      detail="Add your first monthly category cap. Allocations never create bank expenses."
                    />
                  )}
                  <p className="footnote">
                    Positive rollover is opt-in. Overspending does not carry
                    debt into the next month. Late imports and corrections
                    recalculate rollovers.
                  </p>
                </>
              )}
              {page === "Review" && (
                <section className="card">
                  {reviews.length ? (
                    reviews.map((r) => (
                      <div className="review-row" key={r.id}>
                        <div className="review-icon">
                          <AlertCircle size={21} />
                        </div>
                        <div>
                          <h2>
                            {r.description ||
                              r.title ||
                              "Transaction needs review"}
                          </h2>
                          <p>
                            {r.reviewReason ||
                              r.reason ||
                              r.type ||
                              "Check the original evidence before resolving this item."}
                          </p>
                          <small>Transaction: {r.id}</small>
                        </div>
                        <div className="review-actions">
                          <Button
                            variant="outline"
                            disabled={busy}
                            onClick={() => setEdit(r)}
                          >
                            Review details
                          </Button>
                          <ReviewLink
                            review={r}
                            busy={busy}
                            onLink={(pendingId) =>
                              mutate(`/reviews/${r.id}`, {
                                action: "link",
                                pendingId,
                              })
                            }
                          />
                          <Button
                            variant="ghost"
                            disabled={busy}
                            onClick={() =>
                              mutate(`/reviews/${r.id}`, { action: "keep" })
                            }
                          >
                            Keep separate
                          </Button>
                        </div>
                      </div>
                    ))
                  ) : (
                    <Empty
                      title="All clear for now"
                      detail="Ambiguous pending matches and uncertain classifications will appear here."
                      icon={Check}
                    />
                  )}
                </section>
              )}
              {page === "Rules" && (
                <>
                  <div className="section-toolbar">
                    <p>Rules run before optional AI classification.</p>
                    <Button
                      onClick={() =>
                        setRule({
                          match: "",
                          category: "Groceries",
                          kind: "expense",
                        })
                      }
                    >
                      <Plus size={16} />
                      Add rule
                    </Button>
                  </div>
                  <section className="card">
                    {rules.map((r, i) => (
                      <div className="rule-row" key={r.id || i}>
                        <div className="rule-number">{i + 1}</div>
                        <div>
                          <h2>Description contains “{r.match || r.pattern}”</h2>
                          <p>
                            Classify as {r.category} · {r.kind || "expense"}
                          </p>
                        </div>
                        <span className="category-tag">Active</span>
                      </div>
                    ))}
                    {!rules.length && (
                      <Empty
                        title="Put the familiar on autopilot"
                        detail="Create a rule for a merchant or description. Your manual corrections always take priority."
                      />
                    )}
                  </section>
                </>
              )}
              {page === "Settings" && (
                <div className="settings-stack">
                  <section className="card settings-card">
                    <div className="card-heading">
                      <div>
                        <h2>Redbark connection</h2>
                        <p>
                          Server-side configuration keeps credentials out of
                          your browser.
                        </p>
                      </div>
                      <span
                        className={`status-pill ${data.redbark?.verified ? "connected" : ""}`}
                      >
                        {data.redbark?.verified
                          ? "Verified"
                          : data.redbark?.configured
                            ? "Configured · unverified"
                            : "Not connected"}
                      </span>
                    </div>
                    <dl>
                      <div>
                        <dt>Environment</dt>
                        <dd>
                          {session?.demo
                            ? "Demo · fictional fixtures"
                            : "Live · authenticated"}
                        </dd>
                      </div>
                      <div>
                        <dt>API version</dt>
                        <dd>
                          {data.redbark?.version || "2026-10-01.wattle"} · beta
                        </dd>
                      </div>
                      <div>
                        <dt>Signed event webhook</dt>
                        <dd>
                          {data.redbark?.webhookConfigured
                            ? "Configured"
                            : "Not configured"}
                        </dd>
                      </div>
                      <div>
                        <dt>Account discovery</dt>
                        <dd>Every 4 hours</dd>
                      </div>
                      <div>
                        <dt>Last poll</dt>
                        <dd>
                          {data.redbark?.lastPollAt
                            ? new Date(data.redbark.lastPollAt).toLocaleString()
                            : "Not yet run"}
                        </dd>
                      </div>
                    </dl>
                    {data.redbark?.lastError && (
                      <div className="alert alert-error">
                        {data.redbark.lastError}
                      </div>
                    )}
                    <div className="setup-note">
                      <ShieldCheck size={20} />
                      <div>
                        <strong>Connect from your server</strong>
                        <p>
                          Set REDBARK_API_KEY (or its Docker secret file),
                          REDBARK_WEBHOOK_SECRET, and the API version in your
                          server configuration. Restart Profe, then test your
                          connection. Never enter credentials into chat.
                        </p>
                      </div>
                    </div>
                    <Button
                      disabled={busy || session?.demo}
                      onClick={() => mutate("/connection/test", {})}
                    >
                      <RefreshCw size={16} className={busy ? "spin" : ""} />
                      Test connection
                    </Button>
                    {session?.demo && (
                      <p className="footnote">
                        Connection testing is available in live mode. See the
                        deployment guide for setup.
                      </p>
                    )}
                  </section>
                  <section className="card settings-card">
                    <h2>Classification & preferences</h2>
                    <dl>
                      <div>
                        <dt>Currency</dt>
                        <dd>{data.currency || currency}</dd>
                      </div>
                      <div>
                        <dt>Time zone</dt>
                        <dd>
                          {data.timeZone ||
                            session?.timeZone ||
                            "Australia/Brisbane"}
                        </dd>
                      </div>
                      <div>
                        <dt>Optional AI classification</dt>
                        <dd>{data.llm?.enabled ? "Enabled" : "Disabled"}</dd>
                      </div>
                      <div>
                        <dt>Unresolved imports</dt>
                        <dd>
                          {data.llm?.automaticClassification
                            ? "Automatic suggestions"
                            : "AI processing off"}
                        </dd>
                      </div>
                      <div>
                        <dt>Apply AI suggestions</dt>
                        <dd>
                          {data.llm?.automaticApplication
                            ? "Automatic · opted in"
                            : "Manual review required"}
                        </dd>
                      </div>
                      <div>
                        <dt>AI request limit</dt>
                        <dd>{data.llm?.dailyRequestLimit ?? 20} per UTC day</dd>
                      </div>
                      <div>
                        <dt>Actual spending</dt>
                        <dd>Posted only · refunds on refund date</dd>
                      </div>
                    </dl>
                    <p className="muted">
                      Useful provider categories, your rules, and manual
                      corrections work without AI. A configured provider can
                      suggest categories for unresolved posted imports.
                      Automatic application requires a separate server-side
                      opt-in.
                    </p>
                  </section>
                  <section className="card settings-card">
                    <h2>Your data, always yours</h2>
                    <p className="muted">
                      Export this month's transactions as JSON with its report.
                      Use PostgreSQL backups for a complete copy including
                      original provider evidence and audit history.
                    </p>
                    <Button asChild variant="outline">
                      <a
                        href={`/api/export?month=${month}&currency=${currency}`}
                      >
                        <Download size={16} />
                        Export {month}
                      </a>
                    </Button>
                  </section>
                </div>
              )}
            </>
          )}
          <footer className="page-footer">
            <span>
              profe<span className="brand-dot">.</span>{" "}
              <span className="footer-copy">
                A little more clarity. A little less worry.
              </span>
            </span>
            <span>
              {currency} · {session?.timeZone || "Australia/Brisbane"}
            </span>
          </footer>
        </main>
      </div>
      <EditTransaction
        transaction={edit}
        open={!!edit}
        close={() => setEdit(null)}
        busy={busy}
        serverError={error}
        save={async (values) => {
          if (await mutate(`/transactions/${edit.id}`, values, "PATCH"))
            setEdit(null);
        }}
      />
      <BudgetDialog
        currency={currency}
        budget={budget}
        close={() => setBudget(null)}
        busy={busy}
        serverError={error}
        save={async (values) => {
          if (await mutate("/budgets", { ...values, month, currency }, "PUT"))
            setBudget(null);
        }}
      />
      <RuleDialog
        rule={rule}
        close={() => setRule(null)}
        busy={busy}
        serverError={error}
        save={async (values) => {
          if (await mutate("/rules", values)) setRule(null);
        }}
      />
    </div>
  );
}
function ReviewLink({ review, busy, onLink }) {
  const [pendingId, setPendingId] = useState("");
  return (
    <form
      className="review-link"
      onSubmit={(e) => {
        e.preventDefault();
        if (pendingId.trim()) onLink(pendingId.trim());
      }}
    >
      <input
        aria-label="Pending transaction ID"
        placeholder="Pending transaction ID"
        value={pendingId}
        onChange={(e) => setPendingId(e.target.value)}
        required
      />
      <Button variant="outline" disabled={busy || !pendingId.trim()}>
        Link pending
      </Button>
    </form>
  );
}
function Metric({ title, value, subtitle, icon: Icon, color, onClick }) {
  return (
    <button className="card metric" onClick={onClick}>
      <div className="metric-top">
        <span>{title}</span>
        <div className={`metric-icon ${color}`}>
          <Icon size={18} />
        </div>
      </div>
      <strong>{value}</strong>
      <div className="metric-bottom">
        <span>{subtitle}</span>
        <ArrowRight size={14} />
      </div>
    </button>
  );
}
function CashChart({ rows, currency }) {
  const max = Math.max(
    1,
    ...rows.flatMap((r) => [
      Math.abs(Number(r.incomeMinor || 0)),
      Math.abs(Number(r.expensesMinor || 0)),
    ]),
  );
  return (
    <div className="cash-chart">
      <div className="chart-grid-lines">
        <span />
        <span />
        <span />
        <span />
      </div>
      {rows.length ? (
        <div className="chart-bars">
          {rows.map((r, i) => (
            <div key={i} className="chart-column">
              <div className="bar-pair">
                <div
                  className="bar income-bar"
                  title={`Income ${money(r.incomeMinor, currency)}`}
                  style={{
                    height: `${Math.max(2, (Math.abs(Number(r.incomeMinor || 0)) / max) * 100)}%`,
                  }}
                />
                <div
                  className={`bar expense-bar ${BigInt(r.expensesMinor || 0) < 0n ? "refund-bar" : ""}`}
                  title={`${BigInt(r.expensesMinor || 0) < 0n ? "Refund reduces spending" : "Spending"} ${money(r.expensesMinor, currency)}`}
                  style={{
                    height: `${Math.max(2, (Math.abs(Number(r.expensesMinor || 0)) / max) * 100)}%`,
                  }}
                />
              </div>
              <span>
                {rows.length > 15
                  ? i % 5 === 0
                    ? r.label.slice(-2)
                    : ""
                  : r.label.slice(5)}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div className="chart-empty">No posted activity in this period.</div>
      )}
    </div>
  );
}
function CategoryChart({ rows, currency, onSelect }) {
  const colors = ["#7061d8", "#a094e5", "#bfb5f0", "#ddd6f8", "#b8c9c3"];
  const max = Math.max(
    1,
    ...rows.map((r) => Math.abs(Number(r.amountMinor || 0))),
  );
  return (
    <div className="category-chart">
      {rows.slice(0, 6).map((r, i) => (
        <button
          key={r.category}
          onClick={() => onSelect(r.category)}
          className="category-row"
        >
          <div className="category-line">
            <span>
              <i style={{ background: colors[i % colors.length] }} />
              {r.category}
            </span>
            <strong>{money(r.amountMinor, currency)}</strong>
          </div>
          <div className="category-track">
            <div
              style={{
                background: colors[i % colors.length],
                width: `${(Math.abs(Number(r.amountMinor || 0)) / max) * 100}%`,
              }}
            />
          </div>
        </button>
      ))}
      {!rows.length && (
        <Empty
          title="Room for your next chapter"
          detail="Category spending appears when posted expenses are imported."
        />
      )}
    </div>
  );
}
function Empty({ title, detail, icon: Icon = Inbox }) {
  return (
    <div className="empty">
      <div>
        <Icon size={26} />
      </div>
      <h3>{title}</h3>
      <p>{detail}</p>
    </div>
  );
}
function Login({ onLogin }) {
  const [password, setPassword] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <div className="login-screen">
      <form
        className="card login-card"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await api("/login", {
              method: "POST",
              body: JSON.stringify({ password }),
            });
            onLogin(await api("/session"));
          } catch (e) {
            setError(e.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="brand">
          profe<span className="brand-dot">.</span>
        </div>
        <h1>Welcome home.</h1>
        <p className="muted">Sign in to your private financial workspace.</p>
        <label>
          Your password
          <input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error && (
          <p role="alert" className="negative">
            {error}
          </p>
        )}
        <Button disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
          <ArrowRight size={16} />
        </Button>
        <p className="footnote">
          First time? Configure your single-user password on the server using
          the deployment guide.
        </p>
      </form>
    </div>
  );
}
function EditTransaction({
  transaction,
  open,
  close,
  busy,
  save,
  serverError,
}) {
  const [llmEnabled, setLlmEnabled] = useState(false),
    [suggesting, setSuggesting] = useState(false),
    [suggestion, setSuggestion] = useState(null);
  useEffect(() => {
    if (transaction) {
      setSuggestion(null);
      api("/settings")
        .then((s) => setLlmEnabled(!!s.llm?.enabled))
        .catch(() => setLlmEnabled(false));
    }
  }, [transaction]);
  const [category, setCategory] = useState(""),
    [kind, setKind] = useState("expense"),
    [splits, setSplits] = useState([]),
    [error, setError] = useState("");
  useEffect(() => {
    if (transaction) {
      setCategory(transaction.category || "Uncategorized");
      setKind(transaction.kind || "expense");
      setSplits(
        (transaction.splits || []).map((s) => ({
          ...s,
          amount: minorToDecimal(s.amountMinor, transaction.currency),
        })),
      );
      setError("");
    }
  }, [transaction]);
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => !v && close()}
      title="Make it your own"
      description={
        transaction
          ? `${transaction.description} · ${money(transaction.amountMinor, transaction.currency)}`
          : ""
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          try {
            const values = splits.map((s) => ({
              category: s.category,
              amountMinor: decimalToMinor(s.amount, transaction.currency),
            }));
            if (
              values.length &&
              values.reduce((n, s) => n + BigInt(s.amountMinor), 0n) !==
                BigInt(transaction.amountMinor)
            )
              throw new Error(
                "Split amounts must add up exactly to the transaction amount, including its sign.",
              );
            setError("");
            save({ category, kind, splits: values });
          } catch (e) {
            setError(e.message);
          }
        }}
      >
        <label>
          Category
          <input
            list="category-options"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            required
          />
        </label>
        <datalist id="category-options">
          {CATEGORIES.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
        <label>
          Transaction type
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            {["expense", "income", "transfer", "refund"].map((k) => (
              <option key={k}>{k}</option>
            ))}
          </select>
        </label>
        {llmEnabled && (
          <div className="ai-suggestion">
            <Button
              type="button"
              variant="outline"
              disabled={suggesting}
              onClick={async () => {
                setSuggesting(true);
                try {
                  setSuggestion(
                    await api(`/transactions/${transaction.id}/suggest`, {
                      method: "POST",
                      body: "{}",
                    }),
                  );
                } catch (e) {
                  setError(e.message);
                } finally {
                  setSuggesting(false);
                }
              }}
            >
              <Sparkles size={14} />
              {suggesting ? "Getting suggestion…" : "Suggest category with AI"}
            </Button>
            {suggestion && (
              <p className="footnote">
                Suggestion: {suggestion.category}. {suggestion.reason}{" "}
                <button
                  type="button"
                  onClick={() => setCategory(suggestion.category)}
                >
                  Use this category
                </button>{" "}
                · Review before saving.
              </p>
            )}
          </div>
        )}
        <div className="split-heading">
          <strong>Split categories</strong>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() =>
              setSplits([
                ...splits,
                {
                  category: "Other",
                  amount: splits.length
                    ? minorToDecimal("0", transaction.currency)
                    : minorToDecimal(
                        transaction.amountMinor,
                        transaction.currency,
                      ),
                },
              ])
            }
          >
            <Plus size={14} />
            Add split
          </Button>
        </div>
        {splits.map((s, i) => (
          <div className="split-row" key={i}>
            <input
              aria-label={`Split ${i + 1} category`}
              list="category-options"
              value={s.category}
              onChange={(e) =>
                setSplits(
                  splits.map((x, j) =>
                    j === i ? { ...x, category: e.target.value } : x,
                  ),
                )
              }
            />
            <input
              aria-label={`Split ${i + 1} amount`}
              inputMode="decimal"
              value={s.amount}
              onChange={(e) =>
                setSplits(
                  splits.map((x, j) =>
                    j === i ? { ...x, amount: e.target.value } : x,
                  ),
                )
              }
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={`Remove split ${i + 1}`}
              onClick={() => setSplits(splits.filter((_, j) => j !== i))}
            >
              <X size={16} />
            </Button>
          </div>
        ))}
        <p className="footnote">
          Use signed amounts (negative for expenses). Your corrections are
          retained when provider records update.
        </p>
        {error && (
          <p role="alert" className="negative">
            {error}
          </p>
        )}
        {serverError && (
          <p role="alert" className="negative">
            {serverError}
          </p>
        )}
        <div className="dialog-actions">
          <Button type="button" variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button disabled={busy}>Save correction</Button>
        </div>
      </form>
    </Dialog>
  );
}
function BudgetDialog({ budget, close, busy, save, serverError, currency }) {
  const [category, setCategory] = useState(""),
    [cap, setCap] = useState(""),
    [allocation, setAllocation] = useState("0.00"),
    [rollover, setRollover] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    if (budget) {
      setCategory(budget.category);
      setCap(minorToDecimal(budget.capMinor, currency));
      setAllocation(minorToDecimal(budget.allocationMinor, currency));
      setRollover(!!budget.rolloverEnabled);
      setError("");
    }
  }, [budget, currency]);
  return (
    <Dialog
      open={!!budget}
      onOpenChange={(v) => !v && close()}
      title="Make a little plan"
      description="Set a monthly category spending cap."
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          try {
            const capMinor = decimalToMinor(cap, currency);
            if (BigInt(capMinor) < 0n)
              throw new Error("A cap must be positive.");
            const allocationMinor = decimalToMinor(allocation, currency);
            if (BigInt(allocationMinor) < 0n)
              throw new Error("An allocation cannot be negative.");
            save({
              category,
              capMinor,
              allocationMinor,
              rolloverEnabled: rollover,
            });
          } catch (e) {
            setError(e.message);
          }
        }}
      >
        <label>
          Category
          <input
            required
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          />
        </label>
        <label>
          Monthly cap
          <input
            required
            inputMode="decimal"
            value={cap}
            onChange={(e) => setCap(e.target.value)}
          />
        </label>
        <label>
          Additional allocation
          <input
            inputMode="decimal"
            required
            value={allocation}
            onChange={(e) => setAllocation(e.target.value)}
          />
        </label>
        <p className="footnote">
          An allocation adds to this category’s allowance. It does not create a
          bank expense.
        </p>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={rollover}
            onChange={(e) => setRollover(e.target.checked)}
          />
          Roll unused funds into the next month
        </label>
        {error && (
          <p role="alert" className="negative">
            {error}
          </p>
        )}
        {serverError && (
          <p role="alert" className="negative">
            {serverError}
          </p>
        )}
        <div className="dialog-actions">
          <Button type="button" variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button disabled={busy}>Save budget</Button>
        </div>
      </form>
    </Dialog>
  );
}
function RuleDialog({ rule, close, busy, save, serverError }) {
  const [values, setValues] = useState({});
  useEffect(() => {
    setValues(rule || {});
  }, [rule]);
  return (
    <Dialog
      open={!!rule}
      onOpenChange={(v) => !v && close()}
      title="Create a classification rule"
      description="Matches transaction descriptions, ignoring letter case."
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save(values);
        }}
      >
        <label>
          Description contains
          <input
            required
            placeholder="e.g. Woolworths"
            value={values.match || ""}
            onChange={(e) => setValues({ ...values, match: e.target.value })}
          />
        </label>
        <label>
          Assign category
          <input
            required
            value={values.category || ""}
            onChange={(e) => setValues({ ...values, category: e.target.value })}
          />
        </label>
        <label>
          Transaction type
          <select
            value={values.kind || "expense"}
            onChange={(e) => setValues({ ...values, kind: e.target.value })}
          >
            {["expense", "income", "transfer", "refund"].map((k) => (
              <option key={k}>{k}</option>
            ))}
          </select>
        </label>
        {serverError && (
          <p role="alert" className="negative">
            {serverError}
          </p>
        )}
        <div className="dialog-actions">
          <Button type="button" variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button disabled={busy}>Create rule</Button>
        </div>
      </form>
    </Dialog>
  );
}
createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
