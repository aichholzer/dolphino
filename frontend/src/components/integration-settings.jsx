import React, { useEffect, useState } from "react";
import { Button } from "./ui/button";

export function IntegrationSettings({ api, demo }) {
  const [settings, setSettings] = useState(null),
    [webhook, setWebhook] = useState(null),
    [values, setValues] = useState({
      provider: "openai",
      model: "",
      region: "",
      enabled: false,
      autoApply: false,
      dailyRequestLimit: 20,
      batchSize: 5,
    }),
    [secrets, setSecrets] = useState({}),
    [clears, setClears] = useState({}),
    [baseUrl, setBaseUrl] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  async function load() {
    const [p, w] = await Promise.all([
      api("/settings/provider"),
      api("/settings/webhook"),
    ]);
    setSettings(p);
    setValues((v) => ({ ...v, ...p }));
    setWebhook(w);
    setBaseUrl(w.publicBaseUrl || "");
  }
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, []);
  async function action(fn) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await fn();
      setNotice(result.message || "Settings updated.");
      await load();
      return true;
    } catch (e) {
      setError(e.message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  const secretFields =
    values.provider === "bedrock"
      ? [
          ["accessKeyId", "AWS access key ID"],
          ["secretAccessKey", "AWS secret access key"],
        ]
      : [["apiKey", "OpenAI API key"]];
  return (
    <>
      <section className="card settings-card integration-settings">
        <h2>Optional AI classification</h2>
        <p className="muted">
          Rules, provider categories and your corrections take priority. Enable
          AI to send only a minimal description and permitted categories for
          unresolved posted imports.
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
        {!settings && <p>Loading provider settings…</p>}
        {settings && !settings.encryptionAvailable && (
          <p role="status" className="setup-note">
            Credential storage is unavailable. Configure a strong APP_SECRET on
            the server. Your imported financial data remains available.
          </p>
        )}
        {settings?.configured && !settings.credentialsAvailable && (
          <p role="status" className="setup-note">
            Saved credentials cannot currently be used. Check the server
            encryption key or replace the saved values.
          </p>
        )}
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const writeSecrets = {};
            for (const [key] of secretFields) {
              if (clears[key]) writeSecrets[key] = null;
              else if (secrets[key]) writeSecrets[key] = secrets[key];
            }
            if (
              await action(() =>
                api("/settings/provider", {
                  method: "PUT",
                  body: JSON.stringify({
                    provider: values.provider,
                    model: values.model,
                    region: values.region,
                    enabled: values.enabled,
                    autoApply: values.autoApply,
                    dailyRequestLimit: Number(values.dailyRequestLimit),
                    batchSize: Number(values.batchSize),
                    ...writeSecrets,
                  }),
                }),
              )
            ) {
              setSecrets({});
              setClears({});
            }
          }}
        >
          <label>
            Provider
            <select
              aria-label="Provider"
              value={values.provider}
              onChange={(e) => {
                setValues({
                  ...values,
                  provider: e.target.value,
                  model: "",
                  enabled: false,
                });
                setSecrets({});
                setClears({});
              }}
            >
              <option value="openai">OpenAI</option>
              <option value="bedrock">Amazon Bedrock</option>
            </select>
          </label>
          <label>
            {values.provider === "bedrock"
              ? "Model or inference profile ID / ARN"
              : "Model"}
            <input
              required
              maxLength={2048}
              value={values.model}
              placeholder={
                values.provider === "bedrock"
                  ? "Enter an authorized model or inference profile"
                  : "Enter a supported model ID"
              }
              onChange={(e) => setValues({ ...values, model: e.target.value })}
            />
          </label>
          {values.provider === "bedrock" && (
            <label>
              AWS region
              <select
                required
                aria-label="AWS region"
                value={values.region}
                onChange={(e) =>
                  setValues({ ...values, region: e.target.value })
                }
              >
                <option value="">Choose a supported region</option>
                {settings?.regionCatalog?.regions?.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label} · {r.id}
                  </option>
                ))}
              </select>
              <span className="footnote">
                Permanent access keys only. Model availability varies by region.
              </span>
            </label>
          )}
          {secretFields.map(([key, label]) => (
            <div className="secret-setting" key={`${values.provider}-${key}`}>
              <label>
                {label}
                <input
                  type="password"
                  autoComplete="new-password"
                  value={secrets[key] || ""}
                  disabled={!!clears[key]}
                  placeholder="Leave blank to preserve saved value"
                  onChange={(e) =>
                    setSecrets({ ...secrets, [key]: e.target.value })
                  }
                />
              </label>
              <div className="secret-state">
                <span>
                  {settings?.provider === values.provider &&
                  settings?.credentials?.[key]?.configured
                    ? "Saved · hidden"
                    : "No saved value"}
                </span>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={!!clears[key]}
                    onChange={(e) =>
                      setClears({ ...clears, [key]: e.target.checked })
                    }
                  />
                  Clear saved value
                </label>
              </div>
            </div>
          ))}
          <p className="footnote">
            Credentials are write-only and encrypted in PostgreSQL using your
            server’s APP_SECRET. Back up that key separately. A missing or
            changed key prevents credential use, while imported data stays
            available.
          </p>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={!!values.enabled}
              onChange={(e) =>
                setValues({ ...values, enabled: e.target.checked })
              }
            />
            Enable classification of unresolved imports
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={!!values.autoApply}
              onChange={(e) =>
                setValues({ ...values, autoApply: e.target.checked })
              }
            />
            Automatically apply validated category suggestions
          </label>
          <p className="footnote">
            Off by default. Otherwise suggestions wait for your review; invalid
            or uncertain responses always need review.
          </p>
          <div className="settings-row">
            <label>
              Requests per UTC day
              <input
                type="number"
                min="1"
                max="1000"
                value={values.dailyRequestLimit}
                onChange={(e) =>
                  setValues({ ...values, dailyRequestLimit: e.target.value })
                }
              />
            </label>
            <label>
              Maximum import batch
              <input
                type="number"
                min="1"
                max="20"
                value={values.batchSize}
                onChange={(e) =>
                  setValues({ ...values, batchSize: e.target.value })
                }
              />
            </label>
          </div>
          <div className="settings-actions">
            <Button disabled={busy || !settings || demo}>
              Save provider settings
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy || demo}
              onClick={() =>
                action(() =>
                  api("/settings/provider/test-connection", {
                    method: "POST",
                    body: "{}",
                  }),
                )
              }
            >
              Test saved connection
            </Button>
          </div>
          <p className="footnote">
            The model test sends harmless synthetic text using your saved
            configuration. It may incur a tiny inference charge. It sends no
            bank transactions and does not enable classification.
          </p>
          <Button
            type="button"
            variant="outline"
            disabled={busy || demo}
            onClick={() =>
              action(() =>
                api("/settings/provider/test-model", {
                  method: "POST",
                  body: JSON.stringify({ acknowledgeCost: true }),
                }),
              )
            }
          >
            Test saved model · may incur cost
          </Button>
          {demo && (
            <p className="footnote">
              External connection and model tests are unavailable in demo mode.
            </p>
          )}
        </form>
      </section>
      <section className="card settings-card integration-settings">
        <h2>Redbark thin-event notifications</h2>
        <p className="muted">
          Register signed thin-event notifications that trigger account
          reconciliation, not a live bank-feed subscription. Subscribed events:
          sync_run.succeeded and connection.refreshed. dolphino does not create
          a Redbark sync.
        </p>
        <dl>
          <div>
            <dt>Registration</dt>
            <dd>{webhook?.state || "Not registered"}</dd>
          </div>
          <div>
            <dt>Destination</dt>
            <dd>{webhook?.destinationId || "—"}</dd>
          </div>
          <div>
            <dt>Test event receipt</dt>
            <dd>
              {webhook?.pingReceived
                ? "Received and verified"
                : webhook?.pingEventId
                  ? "Sent · awaiting callback"
                  : "Not tested"}
            </dd>
          </div>
        </dl>
        {webhook?.lastError && <p className="negative">{webhook.lastError}</p>}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            action(async () => {
              await api("/settings/webhook/register", {
                method: "POST",
                body: JSON.stringify({ publicBaseUrl: baseUrl }),
              });
              return {
                message:
                  "Thin-event notifications registered/reused: sync_run.succeeded and connection.refreshed trigger reconciliation. No Redbark sync or live bank-feed subscription was created. Independent four-hour polling remains the fallback.",
              };
            });
          }}
        >
          <label>
            Public external HTTPS base URL
            <input
              required
              type="url"
              placeholder="https://dolphino.example.com"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </label>
          <p className="footnote">
            Use a public hostname, not an IP address or private DNS. Redbark
            must reach the callback without an interactive login. Exempt only
            the callback path from Cloudflare Access; keep the app protected.
            The callback verifies signatures and replay protection.
          </p>
          <div className="settings-actions">
            <Button disabled={busy || demo}>
              Register / reuse destination
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy || demo || !webhook?.destinationId}
              onClick={() =>
                action(() =>
                  api("/settings/webhook/test", { method: "POST", body: "{}" }),
                )
              }
            >
              Send test event
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() =>
                action(async () => {
                  await load();
                  return { message: "Registration status refreshed." };
                })
              }
            >
              Refresh status
            </Button>
          </div>
        </form>
        {webhook?.lastError === "signing_secret_recovery_required" && (
          <div className="setup-note">
            <div>
              <strong>Signing secret recovery required</strong>
              <p>
                Recovery rotates the remote signing secret and saves its
                replacement encrypted. Existing deliveries signed with the
                previous secret may need retry.
              </p>
              <Button
                disabled={busy || demo}
                variant="outline"
                onClick={() =>
                  action(() =>
                    api("/settings/webhook/register", {
                      method: "POST",
                      body: JSON.stringify({
                        publicBaseUrl: baseUrl,
                        recoverSigningSecret: true,
                      }),
                    }),
                  )
                }
              >
                Rotate and recover signing secret
              </Button>
            </div>
          </div>
        )}
        <p className="footnote">
          An existing Redbark sync must run successfully to produce
          sync_run.succeeded. connection.refreshed is not a per-transaction
          notification. Independent four-hour polling remains the fallback even
          without events, after connection verification and subject to outages
          and retry delays. No instant bank freshness is promised.
          {demo
            ? " Registration and remote tests are unavailable in demo mode."
            : ""}
        </p>
      </section>
    </>
  );
}
