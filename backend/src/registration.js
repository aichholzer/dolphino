import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { RedbarkClient } from "./redbark.js";

const SECRET = "redbark.webhook.signingSecret";
const EVENTS = ["sync_run.succeeded", "connection.refreshed"];
const WARNING =
  "Thin events trigger REST reconciliation; registration does not create a bank sync or full-data destination. Configure enabled syncs in Redbark. Four-hour polling remains active; bank freshness is not guaranteed.";
function failure(code, status = 400) {
  return Object.assign(new Error(code), { status, code });
}
export function callbackUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw failure("invalid_public_base_url");
  }
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    isIP(host) ||
    host.includes(":") ||
    !host.includes(".") ||
    !/^[a-z0-9.-]+$/.test(host) ||
    /(^|\.)(localhost|local|internal|lan|home|test|invalid|example)$/.test(
      host,
    ) ||
    host.endsWith(".")
  )
    throw failure("public_https_origin_required");
  return `${url.origin}/api/webhooks/redbark`;
}
function publicAddress(address) {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0)) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  // Require global unicast IPv6, excluding documentation range and mapped addresses.
  return (
    isIP(address) === 6 &&
    /^[23]/.test(address) &&
    !address.toLowerCase().startsWith("2001:db8:")
  );
}
export function createRegistration({
  pool,
  settings,
  config,
  client,
  lookupImpl = lookup,
}) {
  const remote =
    client ||
    new RedbarkClient({
      apiKey: config.redbarkApiKey,
      version: config.redbarkVersion,
    });
  async function row(db = pool) {
    return (
      await db.query("SELECT * FROM webhook_registration WHERE singleton=true")
    ).rows[0];
  }
  async function status() {
    const r = await row();
    let secretConfigured = false,
      credentialsUnavailable = false;
    try {
      secretConfigured = Boolean(await settings.getSecret(SECRET, "redbark"));
    } catch {
      credentialsUnavailable = true;
    }
    let pingReceived = false;
    if (r?.ping_event_id)
      pingReceived = Boolean(
        (
          await pool.query("SELECT 1 FROM redbark_receipts WHERE event_id=$1", [
            r.ping_event_id,
          ])
        ).rowCount,
      );
    return {
      state: r?.state || "not_registered",
      destinationId: r?.destination_id || null,
      publicBaseUrl:
        r?.callback_url?.replace(/\/api\/webhooks\/redbark$/, "") || "",
      callbackUrl: r?.callback_url || null,
      secretConfigured,
      credentialsUnavailable,
      lastError: r?.last_error || null,
      lastAttempt: r?.updated_at || null,
      pingEventId: r?.ping_event_id || null,
      pingReceived,
      warning: WARNING,
      contract: "thin",
      enabledEvents: EVENTS,
    };
  }
  async function locked(operation) {
    if (config.mode !== "live")
      throw failure("webhook_registration_requires_live_mode");
    if (!config.redbarkApiKey) throw failure("redbark_api_key_required");
    settings.assertEncryptionReady();
    const db = await pool.connect();
    try {
      await db.query("SELECT pg_advisory_lock(71903901)");
      return await operation(db);
    } catch (error) {
      // Never persist provider response text, URLs, tokens, or decrypted secrets.
      const allowed =
        /^(provider_http_\d{3}|provider_unreachable|signing_secret_recovery_required|duplicate_remote_destinations|invalid_remote_destination|callback_change_requires_manual_cleanup|public_dns_required|registration_required|credentials_unavailable)$/;
      const code = allowed.test(error.code || "")
        ? error.code
        : "registration_failed";
      await db.query(
        "UPDATE webhook_registration SET state='attention',last_error=$1,updated_at=now() WHERE singleton=true",
        [code],
      );
      throw failure(code, 409);
    } finally {
      await db.query("SELECT pg_advisory_unlock(71903901)");
      db.release();
    }
  }
  return {
    async init() {
      await pool.query(
        `CREATE TABLE IF NOT EXISTS webhook_registration(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),callback_url text NOT NULL,destination_id text,state text NOT NULL,last_error text,ping_event_id text,updated_at timestamptz NOT NULL DEFAULT now())`,
      );
    },
    status,
    async runtimeSigningSecret() {
      // If encrypted credentials exist but cannot be decrypted, fail closed (no fallback).
      return (
        (await settings.getSecret(SECRET, "redbark")) ||
        config.redbarkWebhookSecret
      );
    },
    async register({ publicBaseUrl, recoverSigningSecret = false }) {
      const callback = callbackUrl(publicBaseUrl);
      await locked(async (db) => {
        let addresses;
        try {
          addresses = await lookupImpl(new URL(callback).hostname, {
            all: true,
          });
        } catch {
          throw failure("public_dns_required");
        }
        if (
          !addresses.length ||
          addresses.some((a) => !publicAddress(a.address))
        )
          throw failure("public_dns_required");
        const previous = await row(db);
        if (previous && previous.callback_url !== callback)
          throw failure("callback_change_requires_manual_cleanup");
        await db.query(
          `INSERT INTO webhook_registration(singleton,callback_url,state) VALUES(true,$1,'registering') ON CONFLICT(singleton) DO UPDATE SET state='registering',last_error=null,updated_at=now()`,
          [callback],
        );
        const matches = (
          await remote.list("event_destinations?limit=100")
        ).filter((d) => d.webhook_endpoint?.url === callback);
        if (matches.length > 1) throw failure("duplicate_remote_destinations");
        let destination = matches[0],
          secret;
        if (destination) {
          if (!/^ed_[A-Za-z0-9]+$/.test(destination.id))
            throw failure("invalid_remote_destination");
          try {
            if (previous?.destination_id === destination.id)
              secret = await settings.getSecret(SECRET, "redbark", db);
          } catch {
            /* explicit recovery below */
          }
          if (!secret && !recoverSigningSecret)
            throw failure("signing_secret_recovery_required");
          if (!secret) {
            destination = (
              await remote.request(
                `event_destinations/${destination.id}/rotate_secret`,
                { method: "POST", body: {} },
              )
            ).body;
            secret = destination.webhook_endpoint?.signing_secret;
          }
        } else {
          destination = (
            await remote.request("event_destinations", {
              method: "POST",
              body: {
                name: "Dolphino",
                webhook_endpoint: { url: callback },
                enabled_events: EVENTS,
              },
            })
          ).body;
          secret = destination.webhook_endpoint?.signing_secret;
        }
        if (
          !/^ed_[A-Za-z0-9]+$/.test(destination.id) ||
          typeof secret !== "string" ||
          secret.length < 16 ||
          secret.length > 4096
        )
          throw failure("invalid_remote_destination");
        await db.query("BEGIN");
        try {
          await settings.setSecret(SECRET, "redbark", secret, db);
          await db.query(
            "UPDATE webhook_registration SET destination_id=$1,state='registering',last_error=null,updated_at=now() WHERE singleton=true",
            [destination.id],
          );
          await db.query("COMMIT");
        } catch (error) {
          await db.query("ROLLBACK");
          throw error;
        }
        // Persist the one-time key before changing subscriptions or re-enabling delivery.
        if (matches.length) {
          await remote.request(`event_destinations/${destination.id}`, {
            method: "POST",
            body: { enabled_events: EVENTS },
          });
          if (destination.status !== "enabled")
            await remote.request(
              `event_destinations/${destination.id}/enable`,
              { method: "POST", body: {} },
            );
        }
        await db.query(
          "UPDATE webhook_registration SET state='registered',last_error=null,updated_at=now() WHERE singleton=true",
        );
      });
      return status();
    },
    async test() {
      await locked(async (db) => {
        const r = await row(db);
        if (!r?.destination_id) throw failure("registration_required");
        if (!(await settings.getSecret(SECRET, "redbark", db)))
          throw failure("credentials_unavailable");
        const event = (
          await remote.request(`event_destinations/${r.destination_id}/ping`, {
            method: "POST",
            body: {},
          })
        ).body;
        if (!/^evt_[A-Za-z0-9]+$/.test(event.id))
          throw failure("invalid_remote_destination");
        await db.query(
          "UPDATE webhook_registration SET ping_event_id=$1,last_error=null,updated_at=now() WHERE singleton=true",
          [event.id],
        );
      });
      return status();
    },
  };
}
