import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { createSettingsStore } from "../src/settings.js";
import { createTelegramPairing, sendTelegram } from "../src/telegram.js";
const token = "123456789:" + "fictional_test_token_123456789";
const connectionString =
  process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
test("Telegram transport never reflects token/provider bodies, restricts sends and respects retry-after", async () => {
  let calls = 0;
  const fetchImpl = async (url, options) => {
    calls++;
    assert.equal(new URL(url).hostname, "api.telegram.org");
    assert.equal(options.redirect, "error");
    assert.equal(JSON.parse(options.body).chat_id, "-1234");
    return Response.json(
      { ok: false, description: token, parameters: { retry_after: 30 } },
      { status: 429 },
    );
  };
  await assert.rejects(
    sendTelegram({ token, chatId: "-1234", text: "Synthetic test", fetchImpl }),
    (e) =>
      e.message === "telegram_rate_limited" &&
      e.retryAfter === 30 &&
      !e.message.includes(token),
  );
  assert.equal(calls, 1, "transport does not retry uncertain sends");
  await assert.rejects(
    sendTelegram({ token, chatId: "1234", text: "test", fetchImpl }),
    /telegram_message_invalid/,
  );
  await assert.rejects(
    sendTelegram({ token, chatId: "-1234", text: "x".repeat(4001), fetchImpl }),
    /telegram_message_invalid/,
  );
});
test(
  "Telegram pairing requires nonce, private group, same admin session and explicit one-use confirmation",
  { skip: !connectionString },
  async () => {
    const admin = new pg.Pool({ connectionString }),
      schema = `telegram_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      connectionString,
      options: `-c search_path=${schema}`,
    });
    try {
      const settings = createSettingsStore({
        pool,
        appSecret: randomBytes(32).toString("hex"),
      });
      await settings.init();
      await settings.setSecret(
        "notifications.telegram.botToken",
        "telegram",
        token,
      );
      let now = Date.now(),
        updates = [],
        webhook = "",
        conflict = false,
        calls = [];
      const fetchImpl = async (url, options) => {
        const method = url.split("/").at(-1),
          body = JSON.parse(options.body);
        calls.push({ method, body });
        if (conflict && method === "getUpdates")
          return Response.json(
            { ok: false, description: token },
            { status: 409 },
          );
        return Response.json({
          ok: true,
          result:
            method === "getMe"
              ? { is_bot: true, username: "dolphinoTestBot" }
              : method === "getWebhookInfo"
                ? { url: webhook }
                : method === "getUpdates"
                  ? updates
                  : method === "getChat"
                    ? {
                        id: Number(body.chat_id),
                        title: "Fictional household",
                        type: "supergroup",
                      }
                    : null,
        });
      };
      const pairing = createTelegramPairing({
          pool,
          settings,
          fetchImpl,
          now: () => now,
        }),
        session = { sessionId: "synthetic-admin-session" };
      const started = await pairing.start(session),
        nonce = started.command.split(" ")[1];
      assert.ok(started.deepLink.endsWith(nonce));
      assert.ok(
        !JSON.stringify(await settings.getValue("telegram.pairing")).includes(
          nonce,
        ),
      );
      const msg = (id, chatId, text) => ({
        update_id: id,
        message: {
          date: Math.floor(now / 1000),
          from: { is_bot: false },
          chat: { id: chatId, type: "supergroup" },
          text,
        },
      });
      updates = [
        msg(1, -111, "irrelevant other household text"),
        msg(2, -111, "/pair@dolphinoTestBot forged"),
        {
          ...msg(3, -111, started.command),
          message: {
            ...msg(3, -111, started.command).message,
            chat: { id: -111, type: "private" },
          },
        },
      ];
      assert.equal((await pairing.poll(session)).candidate, null);
      assert.equal(
        (await pairing.status({ sessionId: "other" })).candidate,
        null,
      );
      assert.ok(
        !JSON.stringify(await pairing.status(session)).includes("irrelevant"),
      );
      await assert.rejects(
        pairing.poll({ sessionId: "other" }),
        /session_mismatch/,
      );
      updates = [msg(4, -222, `/start@dolphinoTestBot ${nonce}`)];
      const candidate = await pairing.poll(session);
      assert.equal(candidate.candidate.chatId, "-222");
      assert.equal(await settings.getValue("notifications.telegram"), null);
      await assert.rejects(
        pairing.confirm({
          ...session,
          pairingId: started.pairingId,
          chatId: "-111",
        }),
        /candidate_mismatch/,
      );
      await pairing.confirm({
        ...session,
        pairingId: started.pairingId,
        chatId: "-222",
      });
      assert.equal(
        (await settings.getValue("notifications.telegram")).enabled,
        true,
      );
      await assert.rejects(
        pairing.confirm({
          ...session,
          pairingId: started.pairingId,
          chatId: "-222",
        }),
        /expired/,
      );
      await assert.rejects(pairing.poll(session), /expired/);
      await pairing.start(session);
      conflict = true;
      await assert.rejects(pairing.poll(session), /telegram_polling_conflict/);
      conflict = false;
      now += 600001;
      await assert.rejects(pairing.poll(session), /expired/);
      const second = await pairing.start(session);
      updates = [msg(20, -333, second.command), msg(21, -444, second.command)];
      const disputed = await pairing.poll(session);
      assert.equal(disputed.active, false);
      assert.equal(disputed.candidate, null);
      await assert.rejects(
        pairing.confirm({
          ...session,
          pairingId: second.pairingId,
          chatId: "-333",
        }),
        /expired/,
      );
      await pairing.start(session);
      await settings.setSecret(
        "notifications.telegram.botToken",
        "telegram",
        "123456789:replacement_synthetic_token_0123456789",
      );
      await assert.rejects(pairing.poll(session), /token_changed/);
      webhook = "https://other-service.example/callback";
      const before = calls.length;
      await assert.rejects(pairing.start(session), /existing_webhook_refused/);
      assert.ok(!calls.slice(before).some((c) => c.method === "getUpdates"));
      assert.ok(
        !calls.some((c) =>
          ["sendMessage", "deleteWebhook", "setWebhook"].includes(c.method),
        ),
      );
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
