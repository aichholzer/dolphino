import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { Store } from "../src/store.js";
import { createSettingsStore } from "../src/settings.js";
import {
  createNotificationIntegration,
  smtpOptions,
  sendSmtp,
  notificationText,
} from "../src/notifications.js";
test("SMTP enforces TLS and blocks option/header injection, redacts failure", async () => {
  const url =
    "smtp://synthetic%40login:synthetic-password@smtp-relay.brevo.com:587";
  const options = smtpOptions(url);
  assert.equal(options.requireTLS, true);
  assert.equal(options.tls.rejectUnauthorized, true);
  assert.equal(options.auth.user, "synthetic@login");
  for (const bad of [
    url + "?tls.rejectUnauthorized=false",
    url + "#bad",
    url.replace(":587", ":80"),
    url.replace("smtp:", "http:"),
  ])
    assert.throws(() => smtpOptions(bad));
  let received;
  await sendSmtp(
    {
      smtpUrl: url,
      from: "from@example.com",
      to: "to@example.com",
      text: "synthetic",
    },
    (opts) => ({
      sendMail: async (m) => {
        received = { opts, m };
      },
      close() {},
    }),
  );
  assert.equal(received.opts.debug, false);
  await assert.rejects(
    sendSmtp({
      smtpUrl: url,
      from: "from@example.com\r\nBcc: other@example.com",
      to: "to@example.com",
      text: "synthetic",
    }),
  );
  await assert.rejects(
    sendSmtp(
      {
        smtpUrl: url,
        from: "from@example.com",
        to: "to@example.com",
        text: "synthetic",
      },
      () => ({
        sendMail: async () => {
          throw Error("synthetic-password");
        },
        close() {},
      }),
    ),
    (e) => !e.message.includes("synthetic-password"),
  );
  assert.match(
    notificationText({
      category: "Dining",
      month: "2026-09",
      currency: "JPY",
      amountMinor: "123",
      state: "opened",
    }),
    /JPY 123/,
  );
  assert.match(
    notificationText({
      category: "Dining",
      month: "2026-09",
      currency: "KWD",
      amountMinor: "1234",
      state: "opened",
    }),
    /KWD 1.234/,
  );
});
const connectionString =
  process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
test(
  "notification durable outbox dedup retries disabling and mode isolation, single pool connection",
  { skip: !connectionString, timeout: 15000 },
  async () => {
    const admin = new pg.Pool({ connectionString });
    const name = `notifications_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE SCHEMA ${name}`);
    const pool = new pg.Pool({
      connectionString,
      options: `-c search_path=${name}`,
      max: 1,
    });
    const settings = createSettingsStore({
      pool,
      appSecret: randomBytes(32).toString("base64"),
    });
    const store = new Store(pool, { mode: "live" });
    let sends = 0,
      fail = false;
    const n = createNotificationIntegration({
      pool,
      settings,
      mode: "live",
      sendSmtpImpl: async ({ text }) => {
        sends++;
        assert.ok(!text.includes("merchant-private"));
        if (fail) throw Error("SECRET-MUST-NOT-LEAK");
      },
    });
    try {
      await store.migrate();
      await settings.init();
      await n.init();
      const config = {
        audienceConfirmed: true,
        smtp: {
          enabled: true,
          from: "from@example.com",
          recipients: ["to@example.com"],
          smtpUrl:
            "smtps://synthetic:synthetic-password@smtp-relay.brevo.com:465",
        },
      };
      await assert.rejects(
        n.saveSettings({ ...config, audienceConfirmed: false }),
        /audience/,
      );
      await n.saveSettings(config);
      const publicState = await n.getPublicSettings();
      assert.ok(!JSON.stringify(publicState).includes("synthetic-password"));
      const alert = randomUUID();
      await pool.query(
        "INSERT INTO budget_alerts(id,mode,currency,month,category,type,amount_minor,message) VALUES($1,'live','AUD','2026-09','Dining','overspend',100,'private')",
        [alert],
      );
      const event = async (revision, mode = "live") =>
        pool.query(
          "INSERT INTO notification_events(alert_id,revision,mode,payload) VALUES($1,$2,$3,$4)",
          [
            alert,
            revision,
            mode,
            {
              category: "Dining",
              month: "2026-09",
              currency: "AUD",
              amountMinor: "100",
              state: revision === 2 ? "resolved" : "opened",
            },
          ],
        );
      await event(1);
      await n.scan();
      await n.scan();
      assert.equal((await n.deliveries()).length, 1);
      await n.saveSettings({
        ...config,
        smtp: { ...config.smtp, smtpUrl: "" },
      }); // no-op must preserve pending delivery eligibility
      await n.processPending();
      await n.processPending();
      assert.equal(sends, 1);
      assert.equal((await n.deliveries())[0].status, "sent");
      fail = true;
      await event(2);
      await n.processPending();
      assert.equal((await n.deliveries())[0].attempts, 1);
      assert.ok(
        !JSON.stringify(await n.getPublicSettings()).includes(
          "SECRET-MUST-NOT-LEAK",
        ),
      );
      for (let i = 0; i < 4; i++) {
        await pool.query(
          "UPDATE notification_outbox SET next_attempt_at=now()",
        );
        await n.processPending();
      }
      const failed = (await n.deliveries())[0];
      assert.equal(failed.status, "failed");
      assert.equal(failed.attempts, 5);
      await n.retry(failed.id);
      fail = false;
      await n.processPending();
      assert.equal((await n.deliveries())[0].status, "sent");
      await event(3);
      await n.scan();
      await n.saveSettings({
        smtp: { ...config.smtp, enabled: false, smtpUrl: "" },
      });
      const before = sends;
      await n.processPending();
      assert.equal(sends, before);
      assert.equal((await n.deliveries())[0].status, "cancelled");
      await event(4, "demo");
      await n.scan();
      assert.equal(
        (
          await pool.query(
            "SELECT scanned_at FROM notification_events WHERE revision=4",
          )
        ).rows[0].scanned_at,
        null,
      );
      const demo = createNotificationIntegration({
        pool,
        settings,
        mode: "demo",
        sendSmtpImpl: async () => {
          throw Error("Demo must not send");
        },
      });
      await demo.processPending();
      assert.equal((await demo.deliveries()).length, 0);
      await n.saveSettings({ summaryFields: ["period"] });
      assert.ok(
        !(await n.getPublicSettings()).summaryPreview.includes("Dining"),
      );
      await settings.setSecret(
        "notifications.telegram.botToken",
        "telegram",
        "12345:synthetic-token-not-real",
      );
      await settings.setValue("notifications.telegram", {
        enabled: true,
        chatId: "-123",
        enabledAt: new Date().toISOString(),
      });
      let telegramSends = 0;
      let limited = false;
      const telegram = createNotificationIntegration({
        pool,
        settings,
        mode: "live",
        sendTelegram: async () => {
          telegramSends++;
          if (limited)
            throw Object.assign(Error("token-private"), { retryAfter: 900 });
        },
      });
      await event(5);
      await event(6);
      await telegram.processPending();
      assert.equal(
        telegramSends,
        1,
        "same chat cannot burst multiple messages",
      );
      await pool.query(
        "UPDATE notification_outbox SET next_attempt_at=now(),updated_at=now()-interval '10 seconds'",
      );
      limited = true;
      await telegram.processPending();
      assert.equal(telegramSends, 2);
      const delayed = (
        await pool.query(
          "SELECT extract(epoch FROM(next_attempt_at-now())) AS delay FROM notification_outbox WHERE channel='telegram' AND status='pending'",
        )
      ).rows[0];
      assert.ok(
        Number(delayed.delay) > 890,
        "Telegram retry-after is respected",
      );
      assert.ok(
        !JSON.stringify(await telegram.deliveries()).includes("token-private"),
      );
      await n.saveSettings({ audienceConfirmed: false });
      assert.equal((await n.getPublicSettings()).telegram.enabled, false);
      await pool.query(
        "UPDATE notification_outbox SET next_attempt_at=now(),updated_at=now()-interval '10 seconds'",
      );
      const beforeConsentRevocation = telegramSends;
      await telegram.processPending();
      assert.equal(
        telegramSends,
        beforeConsentRevocation,
        "revoked audience consent prevents queued financial delivery",
      );
      await event(7);
      await telegram.scan();
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int n FROM notification_outbox o JOIN notification_events e ON e.id=o.event_id WHERE e.revision=7",
          )
        ).rows[0].n,
        0,
      );
      await telegram.stop();
    } finally {
      await n.stop();
      await pool.end();
      await admin.query(`DROP SCHEMA ${name} CASCADE`);
      await admin.end();
    }
  },
);
