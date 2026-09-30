import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { Store } from "../src/store.js";
import { createSettingsStore } from "../src/settings.js";
import { createNotificationIntegration } from "../src/notifications.js";
const connectionString =
  process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

test(
  "notification reservations survive restart, two workers serialize, Telegram cooldown and Retry-After persist",
  { skip: !connectionString, timeout: 15000 },
  async () => {
    const admin = new pg.Pool({ connectionString });
    const schema = `notification_restart_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString,
      options: `-c search_path=${schema}`,
      max: 4,
    });
    const settings = createSettingsStore({
      pool,
      appSecret: randomBytes(32).toString("base64"),
    });
    const store = new Store(pool, { mode: "live" });
    let sends = 0,
      release,
      arrived;
    const entered = new Promise((resolve) => {
      arrived = resolve;
    });
    const blocked = new Promise((resolve) => {
      release = resolve;
    });
    const sendSmtpImpl = async () => {
      sends++;
      const row = (
        await pool.query(
          "SELECT * FROM notification_outbox WHERE channel='smtp' ORDER BY id LIMIT 1",
        )
      ).rows[0];
      assert.equal(row.attempts, 1, "attempt committed before network send");
      assert(
        new Date(row.next_attempt_at) > new Date(),
        "restart cannot immediately replay in-flight attempt",
      );
      arrived();
      await blocked;
    };
    const make = (extra = {}) =>
      createNotificationIntegration({
        pool,
        settings,
        mode: "live",
        sendSmtpImpl,
        ...extra,
      });
    const first = make(),
      second = make();
    try {
      await store.migrate();
      await settings.init();
      await first.init();
      await first.saveSettings({
        smtp: {
          enabled: true,
          from: "from@example.com",
          recipients: ["to@example.com"],
          smtpUrl: "smtps://synthetic:synthetic@smtp.example.com:465",
        },
      });
      const alert = randomUUID();
      await pool.query(
        "INSERT INTO budget_alerts(id,mode,currency,month,category,type,amount_minor,message) VALUES($1,'live','AUD','2026-09','Dining','overspend',100,'test')",
        [alert],
      );
      const event = async (revision) =>
        pool.query(
          "INSERT INTO notification_events(alert_id,revision,mode,payload) VALUES($1,$2,'live',$3)",
          [
            alert,
            revision,
            {
              category: "Dining",
              month: "2026-09",
              currency: "AUD",
              amountMinor: "100",
              state: "opened",
            },
          ],
        );
      await event(1);
      const running = first.processPending();
      await entered;
      await second.processPending();
      assert.equal(sends, 1, "second worker cannot send locked job");
      release();
      await running;
      await second.processPending();
      assert.equal(sends, 1, "restart skips succeeded job");
      await event(2);
      await second.scan();
      // Crash snapshot: five reservations already consumed, completion outcome unknown.
      await pool.query(
        "UPDATE notification_outbox SET attempts=5,next_attempt_at=now() WHERE status='pending'",
      );
      await make().processPending();
      assert.equal(sends, 1);
      const exhausted = (await second.deliveries())[0];
      assert.equal(exhausted.status, "failed");
      assert.match(exhausted.error, /uncertain after restart/);
      await first.saveSettings({
        smtp: {
          enabled: false,
          from: "from@example.com",
          recipients: ["to@example.com"],
        },
      });
      await settings.setSecret(
        "notifications.telegram.botToken",
        "telegram",
        "123456:synthetic_token_for_tests_only",
      );
      await settings.setValue("notifications.telegram", {
        enabled: true,
        enabledAt: new Date(0).toISOString(),
        chatId: "-12345",
      });
      let telegramSends = 0;
      const telegram = make({
        sendTelegram: async () => {
          telegramSends++;
        },
      });
      await event(3);
      await event(4);
      await telegram.processPending();
      assert.equal(
        telegramSends,
        1,
        "Telegram recipient cooldown defers second delivery",
      );
      const pending = (await telegram.deliveries()).find(
        (row) => row.channel === "telegram" && row.status === "pending",
      );
      assert(pending);
      await make({
        sendTelegram: async () => {
          telegramSends++;
        },
      }).processPending();
      assert.equal(telegramSends, 1, "cooldown survives worker restart");
      await pool.query(
        "UPDATE notification_outbox SET updated_at=now()-interval '10 seconds',next_attempt_at=now() WHERE channel='telegram'",
      );
      const limited = make({
        sendTelegram: async () => {
          telegramSends++;
          throw Object.assign(Error("synthetic-secret"), { retryAfter: 600 });
        },
      });
      await limited.processPending();
      assert.equal(telegramSends, 2);
      const retry = (await limited.deliveries()).find(
        (row) => row.id === pending.id,
      );
      assert.equal(retry.attempts, 1);
      assert(
        new Date(retry.nextAttemptAt).getTime() - Date.now() > 590000,
        "Retry-After retained durably",
      );
      assert(!retry.error.includes("synthetic-secret"));
      await make({
        sendTelegram: async () => {
          telegramSends++;
        },
      }).processPending();
      assert.equal(
        telegramSends,
        2,
        "restart respects provider retry deadline",
      );
      await first.saveSettings({
        smtp: {
          enabled: true,
          from: "from@example.com",
          recipients: ["old@example.com"],
        },
        telegram: { enabled: false },
      });
      await event(5);
      await first.scan();
      const removed = (await first.deliveries()).find(
        (row) => row.channel === "smtp" && row.status === "pending",
      );
      assert(removed);
      await first.saveSettings({
        smtp: {
          enabled: true,
          from: "from@example.com",
          recipients: ["new@example.com"],
        },
      });
      await first.processPending();
      assert.equal(
        sends,
        1,
        "removed recipient is not delivered or silently retargeted",
      );
      assert.equal(
        (await first.deliveries()).find((row) => row.id === removed.id).status,
        "cancelled",
      );
    } finally {
      release?.();
      await first.stop();
      await second.stop();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
