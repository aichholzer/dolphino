import React, { useState, useEffect } from "react";
import { Button } from "./ui/button";
export function NotificationSettings({ api, demo }) {
  const [data, setData] = useState(null),
    [deliveries, setDeliveries] = useState([]),
    [audienceConfirmed, setAudienceConfirmed] = useState(false),
    [summaryFields, setSummaryFields] = useState([
      "category",
      "period",
      "amount",
      "remaining",
    ]),
    [smtp, setSmtp] = useState({ enabled: false, from: "", recipients: [] }),
    [telegram, setTelegram] = useState({ enabled: false }),
    [smtpUrl, setSmtpUrl] = useState(""),
    [token, setToken] = useState(""),
    [clearSmtp, setClearSmtp] = useState(false),
    [clearToken, setClearToken] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [pairing, setPairing] = useState(null);
  async function load() {
    const [d, history, activePairing] = await Promise.all([
      api("/settings/notifications"),
      api("/notifications/deliveries"),
      api("/settings/telegram/pair"),
    ]);
    setDeliveries(Array.isArray(history) ? history : []);
    if (activePairing.active) setPairing((p) => ({ ...p, ...activePairing }));
    setData(d);
    setAudienceConfirmed(!!d.audienceConfirmed);
    setSummaryFields(
      d.summaryFields || ["category", "period", "amount", "remaining"],
    );
    setSmtp(d.smtp || {});
    setTelegram(d.telegram || {});
  }
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, []);
  async function action(fn) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const r = await fn();
      setNotice(r.message || "Notification settings updated.");
      await load();
      return r;
    } catch (e) {
      setError(e.message);
      return null;
    } finally {
      setBusy(false);
    }
  }
  async function save(e) {
    e.preventDefault();
    const body = {
      summaryFields,
      audienceConfirmed,
      smtp: {
        enabled: !!smtp.enabled,
        from: smtp.from || "",
        recipients: (smtp.recipients || []).filter(Boolean),
        ...(clearSmtp ? { smtpUrl: null } : smtpUrl ? { smtpUrl } : {}),
      },
      telegram: {
        enabled: !!telegram.enabled,
        ...(clearToken ? { token: null } : token ? { token } : {}),
      },
    };
    if (
      await action(() =>
        api("/settings/notifications", {
          method: "PUT",
          body: JSON.stringify(body),
        }),
      )
    ) {
      setSmtpUrl("");
      setToken("");
      setClearSmtp(false);
      setClearToken(false);
    }
  }
  return (
    <section className="card settings-card integration-settings notification-settings">
      <h2>Keep the household in the loop</h2>
      <p className="muted">
        Optional delivery of budget alerts. In-app alerts remain available with
        every delivery channel turned off.
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
      <form onSubmit={save}>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={audienceConfirmed}
            onChange={(e) => setAudienceConfirmed(e.target.checked)}
          />
          I understand notifications can show whole-household category totals to
          these email and Telegram recipients, independently of their app
          permissions.
        </label>
        <h3>What to share</h3>
        <p className="footnote">
          Choose fields included in household budget summaries. Bank account
          names and transaction descriptions are never included.
        </p>
        {[
          ["category", "Category"],
          ["period", "Budget period"],
          ["amount", "Overspend amount"],
          ["remaining", "Remaining allowance"],
        ].map(([key, label]) => (
          <label key={key} className="checkbox-label">
            <input
              type="checkbox"
              checked={summaryFields.includes(key)}
              disabled={
                summaryFields.length === 1 && summaryFields.includes(key)
              }
              onChange={(e) =>
                setSummaryFields(
                  e.target.checked
                    ? [...summaryFields, key]
                    : summaryFields.filter((f) => f !== key),
                )
              }
            />
            {label}
          </label>
        ))}
        <div className="setup-note">
          <div>
            <strong>Synthetic summary preview</strong>
            <p>
              {summaryFields
                .map(
                  (f) =>
                    ({
                      category: "Dining",
                      period: "September 2026",
                      amount: "Over budget by AUD 12.34",
                      remaining: "Remaining: −AUD 12.34",
                    })[f],
                )
                .join(" · ")}
            </p>
          </div>
        </div>

        <h3>Email · SMTP</h3>
        <label>
          SMTP connection URL
          <input
            type="password"
            autoComplete="new-password"
            value={smtpUrl}
            disabled={clearSmtp}
            placeholder="Leave blank to preserve saved connection"
            onChange={(e) => setSmtpUrl(e.target.value)}
          />
        </label>
        <p className="footnote">
          {data?.smtp?.credentialConfigured
            ? "Saved · hidden. "
            : "Not configured. "}
          Use smtp://login:password@host:587 with STARTTLS or
          smtps://login:password@host:465. URL-encode special characters in
          credentials. Connection details are encrypted.
        </p>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={clearSmtp}
            onChange={(e) => setClearSmtp(e.target.checked)}
          />
          Clear SMTP connection
        </label>
        <label>
          From email address
          <input
            type="email"
            value={smtp.from || ""}
            onChange={(e) => setSmtp({ ...smtp, from: e.target.value })}
          />
        </label>
        <label>
          Recipients (comma separated)
          <input
            value={(smtp.recipients || []).join(", ")}
            onChange={(e) =>
              setSmtp({
                ...smtp,
                recipients: e.target.value.split(",").map((s) => s.trim()),
              })
            }
          />
        </label>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={!!smtp.enabled}
            onChange={(e) => setSmtp({ ...smtp, enabled: e.target.checked })}
          />
          Enable email alerts
        </label>
        <h3>Telegram · private household group</h3>
        <label>
          Telegram bot token
          <input
            type="password"
            autoComplete="new-password"
            value={token}
            disabled={clearToken}
            placeholder="Leave blank to preserve saved token"
            onChange={(e) => setToken(e.target.value)}
          />
        </label>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={clearToken}
            onChange={(e) => setClearToken(e.target.checked)}
          />
          Clear Telegram bot token
        </label>
        <p className="footnote">
          Create a dedicated private group, then add your household members and
          bot yourself. Keep bot privacy mode on; no administrator permissions
          are needed. Profe does not manage membership.
        </p>
        <p className="footnote">
          {telegram.paired
            ? `Paired group: ${telegram.chatTitle || "confirmed household"}. `
            : "No group paired. "}
          Save your bot token before starting group pairing.
        </p>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={!!telegram.enabled}
            disabled={!telegram.paired}
            onChange={(e) =>
              setTelegram({ ...telegram, enabled: e.target.checked })
            }
          />
          Enable Telegram alerts to the confirmed group
        </label>
        <div className="settings-actions">
          <Button disabled={busy || demo || !data}>
            Save notification settings
          </Button>
        </div>
      </form>
      <div className="settings-actions">
        <Button
          variant="outline"
          disabled={busy || demo}
          onClick={async () => {
            const r = await action(() =>
              api("/settings/telegram/pair", {
                method: "POST",
                body: "{}",
              }),
            );
            if (r) setPairing(r);
          }}
        >
          Pair Telegram group
        </Button>
      </div>
      {pairing && (
        <div className="setup-note">
          <div>
            <strong>Confirm the group before enabling delivery</strong>
            {pairing.expiresAt && (
              <p className="footnote">
                Expires {new Date(pairing.expiresAt).toLocaleString()}. Start
                pairing again if this expires.
              </p>
            )}
            {pairing.deepLink && (
              <p>
                <a href={pairing.deepLink} target="_blank" rel="noreferrer">
                  Add the bot to your private group
                </a>
              </p>
            )}
            <p className="footnote">
              This link expires shortly. After adding the bot, send the pairing
              command in your group, then check for your group. Setup polling
              only works when the bot has no existing webhook.
            </p>
            {pairing.command && (
              <p>
                <code>{pairing.command}</code>
              </p>
            )}
            <Button
              variant="outline"
              disabled={busy}
              onClick={async () => {
                const r = await action(() =>
                  api("/settings/telegram/poll", {
                    method: "POST",
                    body: JSON.stringify({ pairingId: pairing.pairingId }),
                  }),
                );
                if (r) setPairing({ ...pairing, ...r });
              }}
            >
              Check for group
            </Button>
            {pairing.candidate && (
              <div>
                <p>
                  <strong>{pairing.candidate.title}</strong>
                  <br />
                  Group ID: {pairing.candidate.chatId}
                </p>
                <Button
                  disabled={busy}
                  onClick={async () => {
                    const r = await action(() =>
                      api("/settings/telegram/confirm", {
                        method: "POST",
                        body: JSON.stringify({
                          pairingId: pairing.pairingId,
                          chatId: pairing.candidate.chatId,
                        }),
                      }),
                    );
                    if (r) setPairing(null);
                  }}
                >
                  Confirm group and enable Telegram alerts
                </Button>
              </div>
            )}
          </div>
        </div>
      )}
      <p className="footnote">
        Send test delivers a synthetic message to the configured recipients or
        confirmed group. No financial transactions are included.
      </p>
      <div className="settings-actions">
        {["smtp", "telegram"].map((channel) => (
          <Button
            key={channel}
            variant="outline"
            disabled={busy || demo}
            onClick={() =>
              action(() =>
                api("/notifications/test", {
                  method: "POST",
                  body: JSON.stringify({ channel }),
                }),
              )
            }
          >
            Send {channel === "smtp" ? "email" : "Telegram"} test
          </Button>
        ))}
      </div>
      <p className="footnote">
        {data?.pendingCount || 0} pending deliveries · {data?.failedCount || 0}{" "}
        failed deliveries
      </p>
      {data?.recentFailures?.map((r, i) => (
        <p key={i} className="footnote negative">
          {r.channel}: {r.error} · {r.attempts} attempts
        </p>
      ))}
      <h3>Recent deliveries</h3>
      {!deliveries.length && <p className="footnote">No recent deliveries.</p>}
      {deliveries.slice(0, 10).map((d) => (
        <div className="health-account" key={d.id}>
          <strong>
            {d.channel} · {d.status}
          </strong>
          <p className="footnote">
            {d.attempts} attempts{d.error ? ` · ${d.error}` : ""}
          </p>
          {d.status === "failed" && (
            <Button
              variant="outline"
              size="sm"
              disabled={busy || demo}
              onClick={() =>
                action(() =>
                  api(`/notifications/${d.id}/retry`, {
                    method: "POST",
                    body: "{}",
                  }),
                )
              }
            >
              Retry delivery {d.id}
            </Button>
          )}
        </div>
      ))}
      {demo && (
        <p className="footnote">
          Saving credentials, pairing and external delivery are unavailable in
          demo mode.
        </p>
      )}
    </section>
  );
}
