import React, { useState, useEffect } from "react";
import { Button } from "./ui/button";
export function ImportHealth({ api, demo }) {
  const [data, setData] = useState(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [accountId, setAccountId] = useState(""),
    [from, setFrom] = useState(""),
    [to, setTo] = useState("");
  async function load() {
    const d = await api("/import-health");
    setData(d);
  }
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, []);
  async function action(path, body) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const r = await api(path, { method: "POST", body: JSON.stringify(body) });
      setNotice(r.message || "Job queued. Check status after the worker runs.");
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card settings-card integration-settings import-health">
      <h2>Import health & history</h2>
      <p className="muted">
        Check imported coverage and queued work. A successful provider request
        does not guarantee fresh bank activity; account balances are separate
        snapshots.
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
      <Button
        variant="outline"
        disabled={busy}
        onClick={() => load().catch((e) => setError(e.message))}
      >
        Refresh import status
      </Button>
      {data?.accounts?.map((a) => (
        <div className="health-account" key={a.id}>
          <strong>{a.name}</strong>
          <p className="footnote">
            {a.postedCount || 0} posted · {a.pendingCount || 0} pending ·{" "}
            {a.currency}
            <br />
            {a.firstTransactionDate
              ? `${String(a.firstTransactionDate).slice(0, 10)} — ${String(a.lastTransactionDate).slice(0, 10)}`
              : "No imported transactions"}
            <br />
            Last fetched:{" "}
            {a.fetchedAt
              ? new Date(a.fetchedAt).toLocaleString()
              : "Not yet fetched"}
          </p>
        </div>
      ))}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          action("/import-health/backfill", { accountId, from, to });
        }}
      >
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
            {data?.accounts?.map((a) => (
              <option value={a.id} key={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <div className="settings-row">
          <label>
            History from
            <input
              type="date"
              required
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </label>
          <label>
            History to
            <input
              type="date"
              required
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </label>
        </div>
        <p className="footnote">
          Explicit bounded backfill, up to seven years per request. Provider
          coverage may be shorter. Existing records remain intact; overlapping
          imports are deduplicated.
        </p>
        <Button disabled={busy || demo}>Queue history import</Button>
      </form>
      <h3>Recent jobs</h3>
      {!data?.jobs?.length && <p className="footnote">No recent jobs.</p>}
      {data?.jobs?.map((j) => (
        <div className="health-account" key={j.id}>
          <strong>
            {j.type} · {j.status}
          </strong>
          <p className="footnote">
            {j.attempts} attempts{j.lastError ? ` · ${j.lastError}` : ""}
            {j.availableAt
              ? ` · eligible ${new Date(j.availableAt).toLocaleString()}`
              : ""}
          </p>
          {j.lastError && (
            <Button
              variant="outline"
              size="sm"
              disabled={busy || demo}
              onClick={() => action("/import-health/retry", { jobId: j.id })}
            >
              Retry job {j.id}
            </Button>
          )}
        </div>
      ))}
      <p className="footnote">
        Retries honor provider backoff and do not create duplicate jobs.
        {demo
          ? " Remote history imports and retries are unavailable in demo mode."
          : ""}
      </p>
    </section>
  );
}
