import { createHash } from 'node:crypto';
import { verifyTelegramPrivateGroup } from './telegram.mjs';

const failure = (code) => Object.assign(new Error(code), { code, status: 409 });

// Pairing confirmation and notification settings use this same configuration lock.
// Privacy verification runs outside it. Only the final database reads and the
// synchronous start of sendMessage run inside; no transaction/network wait does.
export function createTelegramDelivery({ settings, sendTelegram, verifyTelegramGroup = verifyTelegramPrivateGroup }) {
  async function snapshot(db, { recipient, eventAt, textForFields }) {
    const value = (await settings.getValue('notifications.telegram', db)) || {};
    const audience = (await settings.getValue('notifications.audience', db)) || {};
    if (
      !audience.confirmed ||
      !value.enabled ||
      value.chatId !== recipient ||
      !value.enabledAt ||
      new Date(eventAt) < new Date(value.enabledAt) ||
      new Date(eventAt) < new Date(audience.confirmedAt || 0)
    ) {
      return null;
    }

    const token = await settings.getSecret('notifications.telegram.botToken', 'telegram', db);
    if (!token || value.tokenHash !== createHash('sha256').update(token).digest('hex')) {
      throw failure('telegram_delivery_pairing_invalid');
    }

    const fields = (await settings.getValue('notifications.summaryFields', db))?.fields;
    return Object.freeze({
      token,
      chatId: recipient,
      text: textForFields(fields),
      configuration: JSON.stringify({ value, audience, fields })
    });
  }

  return async function deliver(db, job) {
    if (!sendTelegram) {
      throw failure('telegram_delivery_pairing_invalid');
    }

    const prepared = await snapshot(db, job);
    if (!prepared) {
      return 'cancelled';
    }

    await verifyTelegramGroup({ token: prepared.token, chatId: prepared.chatId });
    if (!(await db.query('SELECT pg_try_advisory_lock(17092382) locked')).rows[0].locked) {
      return 'deferred';
    }

    let completion;
    try {
      const current = await snapshot(db, job);
      if (!current) {
        return 'cancelled';
      }

      if (current.token !== prepared.token || current.configuration !== prepared.configuration) {
        return 'deferred';
      }

      // This adapter must start its fetch synchronously, with no settings reads.
      // Once started, a subsequent disable cannot recall the remote request.
      completion = Promise.resolve(
        sendTelegram(
          Object.freeze({
            token: current.token,
            chatId: current.chatId,
            text: current.text
          })
        )
      );
      // Observe an early failure while the database unlock is still in progress.
      completion.catch(() => {});
    } finally {
      await db.query('SELECT pg_advisory_unlock(17092382)');
    }

    await completion;
    return 'sent';
  };
}
