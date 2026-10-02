import { useState, useEffect, useRef } from 'react';
import { Button } from './ui/button';
import { useSettingsDirty } from '../features/settings/settings-dirty';
export function ImportHealth({ api, demo }) {
  const [data, setData] = useState(null),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [accountId, setAccountId] = useState(''),
    [from, setFrom] = useState(''),
    [to, setTo] = useState('');
  const actionPending = useRef(false);
  useSettingsDirty(busy || accountId || from || to);
  async function load() {
    const d = await api('/import-health');
    setData(d);
  }

  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, []);
  async function action(path, body) {
    if (actionPending.current || demo) {
      return;
    }

    actionPending.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const r = await api(path, { method: 'POST', body: JSON.stringify(body) });
      setNotice(
        path === '/import-health/repair-categories'
          ? `${r.message || 'Category repair complete.'} Accounts checked: ${r.accounts}. Category labels updated: ${r.updated}. Still unresolved: ${r.unresolved}. Saved category references kept for review: ${r.manualReferencesPreserved}. Accounts skipped: ${r.skipped}. Budgets to review: ${r.budgetsNeedingReview ?? 0}. Rules to review: ${r.rulesNeedingReview ?? 0}.`
          : r.message || 'Job queued. Check status after the worker runs.'
      );
      if (path === '/import-health/backfill') {
        setAccountId('');
        setFrom('');
        setTo('');
      }

      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      actionPending.current = false;
      setBusy(false);
    }
  }

  return (
    <section className="card settings-card integration-settings import-health">
      <h2>Import health & history</h2>
      <p className="muted">
        Check imported coverage and direct Redbark jobs. SimpleFIN and PocketSmith manage imports and backfills in their
        settings above. A successful provider request does not guarantee fresh bank activity; account balances are
        separate snapshots.
      </p>
      {error && (
        <p role="alert" className="alert alert-error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="alert alert-success">
          {notice}
        </p>
      )}
      {data?.integration?.categoryWarning && (
        <p role="status" className="alert alert-error">
          Redbark category names could not all be resolved. Known names and your corrections are retained; newly
          imported unresolved categories show as Uncategorized. Older unresolved category IDs are labelled Unresolved
          category until their names can be repaired.{' '}
          {data.integration.categoryWarning === 'category_lookup_forbidden'
            ? 'Bank imports continue. Check that your Redbark key has categories:read permission and access to the category taxonomy.'
            : 'Use Repair category names to refresh the taxonomy, subject to provider backoff. Saved category references need an explicit category choice.'}
        </p>
      )}
      <Button variant="outline" disabled={busy} onClick={() => load().catch((e) => setError(e.message))}>
        Refresh import status
      </Button>
      <h3>Repair category names</h3>
      <p className="footnote">
        Refresh Redbark category names and repair stored labels without reloading bank history. Your transaction amounts
        and manual corrections are retained. Unavailable names remain pending resolution.
      </p>
      <Button variant="outline" disabled={busy || demo} onClick={() => action('/import-health/repair-categories', {})}>
        Repair category names
      </Button>
      {data?.accounts?.map((a) => (
        <div className="health-account" key={a.id}>
          <strong>{a.name}</strong>
          <p className="footnote">
            {a.postedCount || 0} posted · {a.pendingCount || 0} pending · {a.currency}
            <br />
            {a.firstTransactionDate
              ? `${String(a.firstTransactionDate).slice(0, 10)} — ${String(a.lastTransactionDate).slice(0, 10)}`
              : 'No imported transactions'}
            <br />
            Last fetched: {a.fetchedAt ? new Date(a.fetchedAt).toLocaleString() : 'Not yet fetched'}
          </p>
        </div>
      ))}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          action('/import-health/backfill', { accountId, from, to });
        }}
      >
        <fieldset disabled={busy || demo}>
          <h3>Import an earlier date range</h3>
          <label>
            Account for history import
            <select
              aria-label="Account for history import"
              required
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
            >
              <option value="">Choose account</option>
              {data?.accounts
                ?.filter((a) => a.importSource !== 'simplefin')
                .map((a) => (
                  <option value={a.id} key={a.id}>
                    {a.name}
                  </option>
                ))}
            </select>
          </label>
          <div className="settings-row">
            <label>
              History from
              <input type="date" required value={from} onChange={(e) => setFrom(e.target.value)} />
            </label>
            <label>
              History to
              <input type="date" required value={to} onChange={(e) => setTo(e.target.value)} />
            </label>
          </div>
          <p className="footnote">
            Explicit bounded backfill, up to seven years per request. Provider coverage may be shorter. Existing records
            remain intact; overlapping imports are deduplicated.
          </p>
          <Button disabled={busy || demo}>Queue history import</Button>
        </fieldset>
      </form>
      <h3>Recent jobs</h3>
      {!data?.jobs?.length && <p className="footnote">No recent jobs.</p>}
      {data?.jobs?.map((j) => (
        <div className="health-account" key={j.id}>
          <strong>
            {j.type} · {j.status}
          </strong>
          <p className="footnote">
            {j.attempts} attempts{j.lastError ? ` · ${j.lastError}` : ''}
            {j.availableAt ? ` · eligible ${new Date(j.availableAt).toLocaleString()}` : ''}
          </p>
          {j.lastError && (
            <Button
              variant="outline"
              size="sm"
              disabled={busy || demo}
              onClick={() => action('/import-health/retry', { jobId: j.id })}
            >
              Retry job {j.id}
            </Button>
          )}
        </div>
      ))}
      <p className="footnote">
        Retries honor provider backoff and do not create duplicate jobs.
        {demo ? ' Category repairs, remote history imports and retries are unavailable in demo mode.' : ''}
      </p>
    </section>
  );
}
