import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { minorToDecimal } from '../../../shared/money.mjs';
import { smtpEmailSchema as email, smtpOptions, sendSmtp } from './smtp-transport.mjs';
import { createTelegramDelivery } from './telegram-delivery.mjs';
import { telegramDeliveryFailure } from './telegram-errors.mjs';

// Preserve the existing notification-module imports for callers.
export { smtpOptions, sendSmtp } from './smtp-transport.mjs';

const invalid = () => Object.assign(Error('Invalid notification settings'), { status: 400 });
const secret = z.preprocess((v) => (v === '' ? undefined : v), z.string().min(1).max(8192).nullable().optional());
const defaultFields = ['category', 'period', 'amount', 'remaining'];
const schema = z
  .object({
    audienceConfirmed: z.boolean().optional(),
    summaryFields: z
      .array(z.enum(['category', 'period', 'amount', 'remaining']))
      .min(1)
      .max(4)
      .optional(),
    smtp: z
      .object({
        enabled: z.boolean(),
        from: email.or(z.literal('')),
        recipients: z.array(email).max(10),
        smtpUrl: secret
      })
      .strict()
      .optional(),
    telegram: z.object({ enabled: z.boolean(), token: secret }).strict().optional()
  })
  .strict();
export function notificationText(payload, fields = defaultFields) {
  const amount = BigInt(payload.amountMinor || '0');
  const decimal = minorToDecimal(amount.toString(), payload.currency);
  const values = {
    category: String(payload.category).slice(0, 100),
    period: `period ${payload.month}`,
    amount: `overspend ${payload.currency} ${payload.state === 'resolved' ? minorToDecimal('0', payload.currency) : decimal}`,
    remaining: `remaining budget ${payload.state === 'resolved' ? 'no longer negative' : `-${decimal} ${payload.currency}`}`
  };
  return `Dolphino budget ${payload.state}: ${fields
    .map((f) => values[f])
    .filter(Boolean)
    .join('; ')}. Open Dolphino to review.`;
}

export function createNotificationIntegration({
  pool,
  settings,
  mode = 'live',
  sendTelegram,
  verifyTelegramGroup,
  sendSmtpImpl = sendSmtp,
  timerIntervalMs = 15000
}) {
  let timer,
    busy = false;
  const defaults = {
    smtp: { enabled: false, from: '', recipients: [] },
    telegram: { enabled: false }
  };
  const deliverTelegram = createTelegramDelivery({ settings, sendTelegram, verifyTelegramGroup });
  async function config(channel, client = pool) {
    return (await settings.getValue(`notifications.${channel}`, client)) || defaults[channel];
  }

  async function getPublicSettings() {
    const smtp = await config('smtp'),
      telegram = await config('telegram');
    const has = async (setting, provider) =>
      (await pool.query('SELECT 1 FROM encrypted_credentials WHERE setting=$1 AND provider=$2', [setting, provider]))
        .rowCount > 0;
    const smtpConfigured = await has('notifications.smtp.url', 'smtp'),
      telegramConfigured = await has('notifications.telegram.botToken', 'telegram');
    const available = async (setting, provider, configured) => {
      if (!configured) {
        return true;
      }

      try {
        return Boolean(await settings.getSecret(setting, provider));
      } catch {
        return false;
      }
    };

    const smtpAvailable = await available('notifications.smtp.url', 'smtp', smtpConfigured),
      telegramAvailable = await available('notifications.telegram.botToken', 'telegram', telegramConfigured);
    const counts = (
      await pool.query(
        'SELECT o.status,count(*)::int count FROM notification_outbox o JOIN notification_events e ON e.id=o.event_id WHERE e.mode=$1 GROUP BY o.status',
        [mode]
      )
    ).rows;
    const recentFailures = (
      await pool.query(
        'SELECT o.id::text,channel,attempts,error,o.updated_at AS "updatedAt" FROM notification_outbox o JOIN notification_events e ON e.id=o.event_id WHERE e.mode=$1 AND error IS NOT NULL ORDER BY o.updated_at DESC LIMIT 10',
        [mode]
      )
    ).rows;
    const audience = (await settings.getValue('notifications.audience')) || {
      confirmed: false
    };
    const summaryFields = (await settings.getValue('notifications.summaryFields'))?.fields || defaultFields;
    return {
      audienceConfirmed: audience.confirmed === true,
      summaryFields,
      summaryPreview: notificationText(
        {
          category: 'Dining',
          month: '2026-09',
          currency: 'AUD',
          amountMinor: '1234',
          state: 'opened'
        },
        summaryFields
      ),
      smtp: {
        enabled: smtp.enabled && audience.confirmed === true,
        from: smtp.from,
        recipients: smtp.recipients,
        configured: smtpConfigured,
        credentialConfigured: smtpConfigured,
        credentialsAvailable: smtpAvailable
      },
      telegram: {
        enabled: telegram.enabled && audience.confirmed === true,
        paired: !!telegram.chatId,
        chatConfigured: !!telegram.chatId,
        configured: telegramConfigured,
        credentialConfigured: telegramConfigured,
        credentialsAvailable: telegramAvailable,
        chatTitle: telegram.chatTitle || null
      },
      pendingCount: counts.find((r) => r.status === 'pending')?.count || 0,
      failedCount: counts.find((r) => r.status === 'failed')?.count || 0,
      recentFailures
    };
  }

  async function saveSettings(input) {
    const parsed = schema.safeParse(input);
    if (!parsed.success) {
      throw invalid();
    }

    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT pg_advisory_xact_lock(17092382)');
      // Delivery compares these stamps with each event's created_at. Both come from the database clock.
      const stamp = (await c.query('SELECT clock_timestamp() AS at')).rows[0].at.toISOString();
      const priorAudience = (await settings.getValue('notifications.audience', c)) || { confirmed: false };
      const audience =
        parsed.data.audienceConfirmed === undefined
          ? priorAudience
          : {
              confirmed: parsed.data.audienceConfirmed,
              confirmedAt: priorAudience.confirmed === parsed.data.audienceConfirmed ? priorAudience.confirmedAt : stamp
            };
      if (parsed.data.audienceConfirmed !== undefined) {
        await settings.setValue('notifications.audience', audience, c);
      }

      if ((parsed.data.smtp?.enabled || parsed.data.telegram?.enabled) && !audience.confirmed) {
        throw Object.assign(Error('Confirm the whole-household notification audience before enabling delivery'), {
          status: 409
        });
      }

      if (parsed.data.summaryFields) {
        await settings.setValue('notifications.summaryFields', { fields: [...new Set(parsed.data.summaryFields)] }, c);
      }

      if (parsed.data.smtp) {
        const { smtpUrl, ...v } = parsed.data.smtp;
        const previous = await config('smtp', c);
        if (smtpUrl !== undefined) {
          if (smtpUrl !== null) {
            smtpOptions(smtpUrl);
          }

          await settings.setSecret('notifications.smtp.url', 'smtp', smtpUrl, c);
        }

        if (
          v.enabled &&
          (!v.from || !v.recipients.length || !(await settings.getSecret('notifications.smtp.url', 'smtp', c)))
        ) {
          throw Object.assign(Error('Configure SMTP URL, sender and recipient before enabling'), { status: 409 });
        }

        await settings.setValue(
          'notifications.smtp',
          {
            ...v,
            recipients: [...new Set(v.recipients)],
            enabledAt:
              previous.enabled === v.enabled &&
              previous.from === v.from &&
              JSON.stringify(previous.recipients) === JSON.stringify([...new Set(v.recipients)])
                ? previous.enabledAt
                : stamp
          },
          c
        );
      }

      if (parsed.data.telegram) {
        const { token, enabled } = parsed.data.telegram;
        let previous = await config('telegram', c);
        if (token !== undefined) {
          if (token !== null && !/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) {
            throw invalid();
          }

          await settings.setSecret('notifications.telegram.botToken', 'telegram', token, c);
          previous = { enabled: false };
          await settings.setValue('telegram.pairing', {}, c);
        }

        if (
          enabled &&
          (!previous.chatId || !(await settings.getSecret('notifications.telegram.botToken', 'telegram', c)))
        ) {
          throw Object.assign(Error('Pair and confirm a Telegram chat before enabling'), { status: 409 });
        }

        await settings.setValue(
          'notifications.telegram',
          {
            ...previous,
            enabled,
            enabledAt: previous.enabled === enabled ? previous.enabledAt : stamp
          },
          c
        );
      }

      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }

    return getPublicSettings();
  }

  async function scan() {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const audience = (await settings.getValue('notifications.audience', c)) || { confirmed: false };
      const events = (
        await c.query(
          'SELECT * FROM notification_events WHERE scanned_at IS NULL AND mode=$1 ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED',
          [mode]
        )
      ).rows;
      for (const event of events) {
        if (
          event.mode === mode &&
          audience.confirmed &&
          new Date(event.created_at) >= new Date(audience.confirmedAt || 0)
        ) {
          for (const channel of ['smtp', 'telegram']) {
            const value = await config(channel, c);
            if (!value.enabled || !value.enabledAt || new Date(event.created_at) < new Date(value.enabledAt)) {
              continue;
            }

            const recipients = channel === 'smtp' ? value.recipients : [value.chatId];
            for (const recipient of recipients.filter(Boolean)) {
              await c.query(
                'INSERT INTO notification_outbox(event_id,channel,recipient) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
                [event.id, channel, recipient]
              );
            }
          }
        }

        await c.query('UPDATE notification_events SET scanned_at=now() WHERE id=$1', [event.id]);
      }

      await c.query('COMMIT');
      return events.length;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }

  async function send(channel, recipient, text, id, client = pool) {
    const value = await config(channel, client);
    if (channel === 'smtp') {
      return sendSmtpImpl({
        smtpUrl: await settings.getSecret('notifications.smtp.url', 'smtp', client),
        from: value.from,
        to: recipient,
        text,
        // Stable per-delivery Message-ID for retries within this deployment.
        messageId: `<dolphino-notification-${id}@dolphino.local>`
      });
    }

    if (!sendTelegram) {
      throw Error('Telegram adapter unavailable');
    }

    return sendTelegram({
      token: await settings.getSecret('notifications.telegram.botToken', 'telegram', client),
      chatId: recipient,
      text
    });
  }

  async function processPending() {
    if (busy || mode !== 'live') {
      return;
    }

    busy = true;
    let lock;
    try {
      await scan();
      lock = await pool.connect();
      if (
        !(await lock.query('SELECT pg_try_advisory_lock(hashtext(current_schema()),17092383) locked')).rows[0].locked
      ) {
        return;
      }

      const jobs = (
        await lock.query(
          "SELECT o.*,e.payload,e.created_at AS event_at FROM notification_outbox o JOIN notification_events e ON e.id=o.event_id WHERE e.mode=$1 AND o.status='pending' AND o.next_attempt_at<=now() ORDER BY o.id LIMIT 5",
          [mode]
        )
      ).rows;
      for (const job of jobs) {
        const value = await config(job.channel, lock);
        const audience = (await settings.getValue('notifications.audience', lock)) || { confirmed: false };
        const recipients = job.channel === 'smtp' ? value.recipients : [value.chatId];
        if (
          !audience.confirmed ||
          new Date(job.event_at) < new Date(audience.confirmedAt || 0) ||
          !value.enabled ||
          !recipients.includes(job.recipient) ||
          new Date(job.event_at) < new Date(value.enabledAt || 0)
        ) {
          await lock.query("UPDATE notification_outbox SET status='cancelled',updated_at=now() WHERE id=$1", [job.id]);
          continue;
        }

        if (job.channel === 'telegram') {
          // One message per chat every 3.1 seconds, measured on the database clock.
          const { until } =
            (
              await lock.query(
                "SELECT max(updated_at)+interval '3100 milliseconds' AS until FROM notification_outbox WHERE channel='telegram' AND recipient=$1 AND attempts>0 HAVING max(updated_at)+interval '3100 milliseconds'>clock_timestamp()",
                [job.recipient]
              )
            ).rows[0] || {};
          if (until) {
            await lock.query('UPDATE notification_outbox SET next_attempt_at=$2 WHERE id=$1', [job.id, until]);
            continue;
          }
        }

        if (job.attempts >= 5) {
          await lock.query(
            "UPDATE notification_outbox SET status='failed',error='Delivery outcome uncertain after restart; review before retry',updated_at=now() WHERE id=$1",
            [job.id]
          );
          continue;
        }

        await lock.query(
          "UPDATE notification_outbox SET attempts=attempts+1,next_attempt_at=now()+interval '1 minute',updated_at=now(),error='Delivery in progress; outcome may be uncertain after restart' WHERE id=$1",
          [job.id]
        );
        try {
          if (job.channel === 'telegram') {
            const outcome = await deliverTelegram(lock, {
              recipient: job.recipient,
              eventAt: job.event_at,
              textForFields: (fields) => notificationText(job.payload, fields)
            });
            if (outcome !== 'sent') {
              await lock.query('UPDATE notification_outbox SET status=$2,error=$3,updated_at=now() WHERE id=$1', [
                job.id,
                outcome === 'cancelled' ? 'cancelled' : 'pending',
                outcome === 'cancelled'
                  ? 'Telegram settings changed; delivery to the previous destination was cancelled.'
                  : 'Telegram settings changed or are busy; privacy will be checked again before retrying.'
              ]);
              continue;
            }
          } else {
            await send(
              job.channel,
              job.recipient,
              notificationText(
                job.payload,
                (await settings.getValue('notifications.summaryFields', lock))?.fields || defaultFields
              ),
              job.id,
              lock
            );
          }

          await lock.query("UPDATE notification_outbox SET status='sent',error=NULL,updated_at=now() WHERE id=$1", [
            job.id
          ]);
        } catch (error) {
          const telegramFailure = job.channel === 'telegram' && telegramDeliveryFailure(error);
          if (telegramFailure?.terminal) {
            await lock.query("UPDATE notification_outbox SET status='failed',error=$2,updated_at=now() WHERE id=$1", [
              job.id,
              telegramFailure.message
            ]);
            continue;
          }

          if (error?.code === 'telegram_group_migrated_repair_required') {
            await lock.query(
              "UPDATE notification_outbox SET status='failed',error='Telegram group migrated; pair and confirm the new group before retry',updated_at=now() WHERE id=$1",
              [job.id]
            );
            continue;
          }

          const retryAfter = Math.max(0, Math.min(86400, Number(error?.retryAfter) || 0));
          await lock.query(
            "UPDATE notification_outbox SET status=CASE WHEN attempts>=5 THEN 'failed' ELSE 'pending' END,error=$2,next_attempt_at=now()+make_interval(secs=>greatest($3::int,least(3600,60*power(2,attempts))::int)),updated_at=now() WHERE id=$1",
            [
              job.id,
              telegramFailure?.message ||
                `${job.channel === 'smtp' ? 'SMTP' : 'Telegram'} delivery failed; verify configuration and provider availability`,
              Math.ceil(retryAfter)
            ]
          );
        }
      }
    } finally {
      if (lock) {
        await lock.query('SELECT pg_advisory_unlock(hashtext(current_schema()),17092383)');
        lock.release();
      }

      busy = false;
    }
  }

  async function testChannel(channel) {
    if (!['smtp', 'telegram'].includes(channel)) {
      throw invalid();
    }

    const value = await config(channel);
    const recipients = channel === 'smtp' ? value.recipients : [value.chatId];
    if (!recipients?.length || recipients.some((r) => !r)) {
      throw Object.assign(Error('Configure notification destination first'), {
        status: 409
      });
    }

    for (const recipient of recipients) {
      await send(
        channel,
        recipient,
        'Dolphino synthetic test: notifications are configured. No transactions or account information are included.',
        `test-${Date.now()}`
      );
    }

    return { ok: true, message: 'Synthetic notification sent' };
  }

  async function deliveries() {
    return (
      await pool.query(
        'SELECT o.id::text,channel,status,attempts,error,o.created_at AS "createdAt",o.updated_at AS "updatedAt",next_attempt_at AS "nextAttemptAt" FROM notification_outbox o JOIN notification_events e ON e.id=o.event_id WHERE e.mode=$1 ORDER BY o.id DESC LIMIT 100',
        [mode]
      )
    ).rows;
  }

  async function retry(id) {
    if (!/^\d+$/.test(String(id))) {
      throw invalid();
    }

    const row = await pool.query(
      "UPDATE notification_outbox SET status='pending',attempts=0,next_attempt_at=now(),error=NULL WHERE id=$1 AND status='failed' AND event_id IN (SELECT id FROM notification_events WHERE mode=$2) RETURNING id",
      [id, mode]
    );
    if (!row.rowCount) {
      throw Object.assign(Error('Failed delivery not found'), { status: 404 });
    }

    return { ok: true };
  }

  return {
    init: async () =>
      pool.query(await readFile(new URL('../../migrations/007_notifications.sql', import.meta.url), 'utf8')),
    getPublicSettings,
    saveSettings,
    scan,
    processPending,
    testChannel,
    deliveries,
    retry,
    start() {
      if (!timer) {
        timer = setInterval(() => processPending().catch(() => {}), timerIntervalMs);
        timer.unref();
      }
    },
    async stop() {
      clearInterval(timer);
      timer = null;
      while (busy) {
        await new Promise((r) => setTimeout(r, 10));
      }
    }
  };
}
