import { createHash } from 'node:crypto';
import { z } from 'zod';
import { householdSessionToken } from '../household-auth.js';
import { body } from '../http/body.mjs';

export function registerNotificationRoutes({ route, notifications, telegram, sensitive }) {
  const pairingSession = (req) =>
    createHash('sha256')
      .update(householdSessionToken(req) || '')
      .digest('hex');
  route('get', '/api/settings/notifications', () => notifications.getPublicSettings());

  route('put', '/api/settings/notifications', async (req) => {
    sensitive('notification-save');
    return notifications.saveSettings(await body(req));
  });

  route('post', '/api/notifications/test', async (req) => {
    sensitive('notification-test');
    const { channel } = z
      .object({ channel: z.enum(['smtp', 'telegram']) })
      .strict()
      .parse(await body(req));
    return notifications.testChannel(channel);
  });

  route('get', '/api/notifications/deliveries', () => notifications.deliveries());

  route('post', '/api/notifications/:id/retry', (req) => {
    sensitive('notification-retry');
    return notifications.retry(req.params.id);
  });

  route('get', '/api/settings/telegram/pair', (req) => telegram.status({ sessionId: pairingSession(req) }));

  route('post', '/api/settings/telegram/pair', (req) => {
    sensitive('telegram-pair');
    return telegram.start({ sessionId: pairingSession(req) });
  });

  route('post', '/api/settings/telegram/poll', (req) => {
    sensitive('telegram-poll');
    return telegram.poll({ sessionId: pairingSession(req) });
  });

  route('post', '/api/settings/telegram/confirm', async (req) => {
    sensitive('telegram-confirm');
    return telegram.confirm({
      ...z
        .object({
          pairingId: z.string().regex(/^[a-f0-9]{32}$/),
          chatId: z.string().regex(/^-\d{1,19}$/)
        })
        .strict()
        .parse(await body(req)),
      sessionId: pairingSession(req)
    });
  });
}
