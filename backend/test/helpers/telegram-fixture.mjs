import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { readTestPostgresConfig } from './postgres.mjs';
import { Store } from '../../src/lib/store.mjs';
import { createSettingsStore } from '../../src/lib/settings.mjs';
import { createNotificationIntegration } from '../../src/lib/notifications.mjs';
import { createTelegramPairing } from '../../src/lib/telegram.mjs';
import { createHouseholdAuth } from '../../src/lib/household-auth.mjs';
import { createApp } from '../../src/app.mjs';

export const syntheticTelegramToken = '123456789:synthetic_telegram_token_1234567890';

export async function telegramFixture() {
  const database = readTestPostgresConfig();
  if (!database) {
    throw Error('Configure a disposable PostgreSQL database');
  }

  const admin = new pg.Pool(database),
    schema = `telegram_hotfix_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ ...database, options: `-c search_path=${schema}` });
  let server, hook, command;
  const calls = [];
  const close = async () => {
    if (server) {
      await new Promise((r) => server.close(r));
    }

    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  };

  try {
    const config = {
      mode: 'live',
      host: '127.0.0.1',
      port: 0,
      origin: 'http://127.0.0.1',
      currency: 'AUD',
      timezone: 'Etc/UTC',
      appSecret: randomBytes(32).toString('base64'),
      bootstrapToken: randomBytes(32).toString('hex')
    };
    const store = new Store(pool, { mode: 'live', timezone: config.timezone });
    await store.migrate();
    const settings = createSettingsStore({ pool, appSecret: config.appSecret });
    await settings.init();
    const notifications = createNotificationIntegration({
      pool,
      settings,
      mode: 'live',
      sendTelegram: async () => {
        throw Error('No real delivery allowed');
      }
    });
    await notifications.init();
    const fetchImpl = async (url, options) => {
      const method = new URL(url).pathname.split('/').at(-1);
      calls.push(method);
      if (!['getMe', 'getWebhookInfo', 'getUpdates', 'getChat'].includes(method)) {
        throw Error('No Telegram writes allowed');
      }

      if (hook) {
        const response = await hook(method, options);
        if (response) {
          return response;
        }
      }

      const result =
        method === 'getMe'
          ? { is_bot: true, username: 'dolphinoSyntheticBot' }
          : method === 'getWebhookInfo'
            ? { url: '' }
            : method === 'getChat'
              ? { id: -987654321, type: 'group', title: 'Synthetic private group' }
              : command
                ? [
                    {
                      update_id: 1,
                      message: {
                        date: Math.floor(Date.now() / 1000),
                        text: command,
                        from: { is_bot: false },
                        chat: { id: -987654321, type: 'group' }
                      }
                    }
                  ]
                : [];
      return Response.json({ ok: true, result });
    };

    const telegram = createTelegramPairing({ pool, settings, fetchImpl });
    const auth = createHouseholdAuth({ pool, config });
    await auth.init();
    const request = { headers: {}, socket: { remoteAddress: '127.0.0.1' } };
    const session = await auth.bootstrap(request, {
      email: 'telegram-admin@example.test',
      name: 'Synthetic admin',
      password: 'Synthetic Telegram test password',
      bootstrapToken: config.bootstrapToken
    });
    const cookie = session.cookie.split(';')[0];
    const member = (
      await pool.query(
        "INSERT INTO household_users(email,name,role,password_hash) SELECT 'telegram-member@example.test','Synthetic member','member',password_hash FROM household_users WHERE id=$1 RETURNING id",
        [session.user.id]
      )
    ).rows[0];
    const memberCookie = (
      await auth.login(request, { email: 'telegram-member@example.test', password: 'Synthetic Telegram test password' })
    ).cookie.split(';')[0];
    const app = createApp({
      store,
      settings,
      config,
      auth,
      notifications,
      telegram,
      integration: { status: async () => ({ configured: false }) },
      assistantSettings: { getUserStatus: async () => ({ enabled: false }) }
    });
    server = await new Promise((resolve) => {
      const s = app.start(() => resolve(s));
    });
    const url = `http://127.0.0.1:${server.address().port}`;
    config.origin = url;
    const http = (path, { method = 'GET', body, origin = url, authCookie = cookie } = {}) =>
      fetch(url + '/api' + path, {
        method,
        headers: { Cookie: authCookie, Origin: origin, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
    return {
      pool,
      store,
      settings,
      config,
      notifications,
      telegram,
      url,
      cookie,
      memberCookie,
      member,
      calls,
      http,
      close,
      setHook(value) {
        hook = value;
      },
      setCommand(value) {
        command = value;
      },
      save: (values = {}) =>
        http('/settings/notifications', {
          method: 'PUT',
          body: { audienceConfirmed: true, telegram: { enabled: false, token: syntheticTelegramToken }, ...values }
        })
    };
  } catch (error) {
    await close();
    throw error;
  }
}
