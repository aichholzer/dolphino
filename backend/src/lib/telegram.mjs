import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { telegramTransportCode } from './telegram-errors.mjs';
import { telegramDispatcher } from './telegram-transport.mjs';
const TOKEN_SETTING = 'notifications.telegram.botToken';
const PAIRING = 'telegram.pairing';
const DESTINATION = 'notifications.telegram';
const digest = (value) => createHash('sha256').update(value).digest('hex');
const fail = (code, status = 409, retryAfter = 0) => Object.assign(new Error(code), { code, status, retryAfter });
export function createTelegramClient({ token, fetchImpl = fetch }) {
  if (typeof token !== 'string' || !/^\d{5,20}:[A-Za-z0-9_-]{20,200}$/.test(token)) {
    throw fail('telegram_token_invalid');
  }

  async function request(method, body = {}) {
    if (!['getMe', 'getWebhookInfo', 'getUpdates', 'getChat', 'sendMessage'].includes(method)) {
      throw fail('telegram_method_invalid');
    }

    let response, result;
    try {
      response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        redirect: 'error',
        dispatcher: telegramDispatcher(),
        signal: AbortSignal.timeout(12000)
      });
    } catch (error) {
      throw fail(telegramTransportCode(error), 502);
    }

    try {
      result = await response.json();
    } catch (error) {
      throw fail(telegramTransportCode(error, 'telegram_response_invalid'), 502);
    }

    if (!result || typeof result !== 'object' || Array.isArray(result) || typeof result.ok !== 'boolean') {
      throw fail('telegram_response_invalid', 502);
    }

    if (!response.ok && result.parameters?.migrate_to_chat_id !== undefined) {
      throw fail('telegram_group_migrated_repair_required', 409);
    }

    if (!response.ok || result.ok !== true) {
      const status = Number.isInteger(result.error_code) ? result.error_code : response.status;
      throw fail(
        status === 401 || (status === 404 && method === 'getMe')
          ? 'telegram_token_rejected'
          : status === 403
            ? 'telegram_access_denied'
            : status === 409
              ? 'telegram_polling_conflict'
              : status === 429
                ? 'telegram_rate_limited'
                : 'telegram_request_failed',
        502,
        Math.min(86400, Math.max(1, Number(result.parameters?.retry_after) || 60))
      );
    }

    return result.result;
  }

  return {
    request,
    async send({ chatId, text }) {
      if (!/^-\d{1,16}$/.test(String(chatId)) || typeof text !== 'string' || text.length < 1 || text.length > 4000) {
        throw fail('telegram_message_invalid', 400);
      }

      const message = await request('sendMessage', {
        chat_id: String(chatId),
        text,
        link_preview_options: { is_disabled: true }
      });
      if (!Number.isSafeInteger(message?.message_id)) {
        throw fail('telegram_response_invalid', 502);
      }

      return { messageId: message.message_id };
    }
  };
}

export function createTelegramPairing({ pool, settings, fetchImpl, now = Date.now }) {
  async function token(db = pool) {
    const value = await settings.getSecret(TOKEN_SETTING, 'telegram', db);
    if (!value) {
      throw fail('telegram_token_required');
    }

    return value;
  }

  async function lock(fn) {
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      await db.query('SELECT pg_advisory_xact_lock(17092382)');
      const result = await fn(db);
      await db.query('COMMIT');
      return result;
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    } finally {
      db.release();
    }
  }

  async function current(db, sessionId) {
    const state = await settings.getValue(PAIRING, db);
    if (!state || state.expiresAt <= now() || state.used) {
      throw fail('telegram_pairing_expired');
    }

    if (!sessionId || state.sessionHash !== digest(sessionId)) {
      throw fail('telegram_pairing_session_mismatch');
    }

    if (state.tokenHash !== digest(await token(db))) {
      throw fail('telegram_token_changed_restart_pairing');
    }

    return state;
  }

  async function client(db) {
    return createTelegramClient({ token: await token(db), fetchImpl });
  }

  async function noWebhook(api) {
    const info = await api.request('getWebhookInfo');
    if (typeof info?.url !== 'string') {
      throw fail('telegram_response_invalid');
    }

    if (info.url) {
      throw fail('telegram_existing_webhook_refused');
    }
  }

  return {
    async init() {},
    async start({ sessionId }) {
      if (typeof sessionId !== 'string' || !sessionId) {
        throw fail('telegram_pairing_session_required');
      }

      return lock(async (db) => {
        const api = await client(db);
        const bot = await api.request('getMe');
        await noWebhook(api);
        if (!bot?.is_bot || !/^[a-zA-Z0-9_]{5,32}$/.test(bot.username)) {
          throw fail('telegram_bot_invalid');
        }

        const nonce = randomBytes(24).toString('base64url'),
          id = randomBytes(16).toString('hex'),
          expiresAt = now() + 10 * 60 * 1000;
        await settings.setValue(
          PAIRING,
          {
            id,
            sessionHash: digest(sessionId),
            nonceHash: digest(nonce),
            tokenHash: digest(await token(db)),
            botUsername: bot.username,
            startedAt: now(),
            expiresAt,
            offset: 0,
            candidate: null,
            used: false
          },
          db
        );
        return {
          pairingId: id,
          command: `/pair@${bot.username} ${nonce}`,
          deepLink: `https://t.me/${bot.username}?startgroup=${nonce}`,
          expiresAt
        };
      });
    },
    async status({ sessionId }) {
      const state = await settings.getValue(PAIRING);
      if (state && (!sessionId || state.sessionHash !== digest(sessionId))) {
        return {
          active: false,
          candidate: null,
          pairingId: null,
          expiresAt: null
        };
      }

      return {
        pairingId: state?.id || null,
        expiresAt: state?.expiresAt || null,
        active: Boolean(state && !state.used && state.expiresAt > now()),
        candidate: state?.candidate || null
      };
    },
    async poll({ sessionId }) {
      return lock(async (db) => {
        const state = await current(db, sessionId),
          api = await client(db);
        await noWebhook(api);
        const updates = await api.request('getUpdates', {
          offset: state.offset,
          limit: 100,
          timeout: 3,
          allowed_updates: ['message']
        });
        if (!Array.isArray(updates) || updates.length > 100) {
          throw fail('telegram_response_invalid');
        }

        for (const update of updates) {
          if (!Number.isSafeInteger(update.update_id) || update.update_id < state.offset) {
            continue;
          }

          state.offset = Math.max(state.offset, update.update_id + 1);
          const m = update.message;
          if (
            !m ||
            !Number.isSafeInteger(m.date) ||
            m.date * 1000 < state.startedAt - 1000 ||
            m.date * 1000 > now() + 30000 ||
            m.forward_origin ||
            m.from?.is_bot !== false ||
            !Number.isSafeInteger(m.chat?.id) ||
            m.chat.id >= 0 ||
            !['group', 'supergroup'].includes(m.chat.type) ||
            m.chat.username
          ) {
            continue;
          }

          const match =
            typeof m.text === 'string' && m.text.match(/^\/(?:pair|start)(?:@([a-zA-Z0-9_]+))? ([A-Za-z0-9_-]{32})$/);
          if (!match || (match[1] && match[1].toLowerCase() !== state.botUsername.toLowerCase())) {
            continue;
          }

          if (!timingSafeEqual(Buffer.from(digest(match[2]), 'hex'), Buffer.from(state.nonceHash, 'hex'))) {
            continue;
          }

          const chat = await api.request('getChat', {
            chat_id: String(m.chat.id)
          });
          if (chat?.id !== m.chat.id || !['group', 'supergroup'].includes(chat.type) || chat.username) {
            throw fail('telegram_private_group_required');
          }

          const candidate = {
            chatId: String(chat.id),
            title: String(chat.title || 'Private household group').slice(0, 160),
            type: chat.type
          };
          if (state.candidate && state.candidate.chatId !== candidate.chatId) {
            state.used = true;
            state.candidate = null;
            state.error = 'telegram_pairing_conflict_restart';
            break;
          }

          state.candidate = candidate;
        }

        await settings.setValue(PAIRING, state, db);
        return {
          pairingId: state.id,
          expiresAt: state.expiresAt,
          active: !state.used,
          candidate: state.candidate,
          error: state.error || null
        };
      });
    },
    async confirm({ pairingId, chatId, sessionId }) {
      return lock(async (db) => {
        const state = await current(db, sessionId);
        if (state.id !== pairingId || !state.candidate || state.candidate.chatId !== String(chatId)) {
          throw fail('telegram_candidate_mismatch');
        }

        const api = await client(db);
        await noWebhook(api);
        const chat = await api.request('getChat', {
          chat_id: state.candidate.chatId
        });
        if (
          String(chat?.id) !== state.candidate.chatId ||
          !['group', 'supergroup'].includes(chat.type) ||
          chat.username
        ) {
          throw fail('telegram_private_group_required');
        }

        if (String(chat.title || 'Private household group').slice(0, 160) !== state.candidate.title) {
          throw fail('telegram_group_changed_restart_pairing');
        }

        const destination = {
          chatId: state.candidate.chatId,
          chatTitle: state.candidate.title,
          enabled: true,
          // Delivery compares this with event created_at, on the database clock.
          enabledAt: (await db.query('SELECT clock_timestamp() AS at')).rows[0].at.toISOString(),
          tokenHash: state.tokenHash
        };
        await settings.setValue(DESTINATION, destination, db);
        await settings.setValue(PAIRING, { ...state, used: true, nonceHash: null }, db);
        return {
          paired: true,
          chatId: destination.chatId,
          chatTitle: destination.chatTitle
        };
      });
    }
  };
}

export async function sendTelegram({ token, chatId, text, fetchImpl }) {
  return createTelegramClient({ token, fetchImpl }).send({ chatId, text });
}

export async function verifyTelegramPrivateGroup({ token, chatId, fetchImpl }) {
  let chat;
  try {
    chat = await createTelegramClient({ token, fetchImpl }).request('getChat', { chat_id: chatId });
  } catch (error) {
    throw fail('telegram_delivery_privacy_unverified', 502, error?.retryAfter || 0);
  }

  if (
    !Number.isSafeInteger(chat?.id) ||
    chat.id >= 0 ||
    String(chat.id) !== chatId ||
    !['group', 'supergroup'].includes(chat.type) ||
    chat.username ||
    (chat.active_usernames !== undefined && (!Array.isArray(chat.active_usernames) || chat.active_usernames.length))
  ) {
    throw fail('telegram_delivery_private_group_required');
  }
}
