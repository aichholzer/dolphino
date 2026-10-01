import { readTestPostgresConfig } from './helpers/postgres.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomBytes, randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { createHouseholdAuth } from '../src/household-auth.js';
import { createSettingsStore } from '../src/settings.js';
import { createTelegramPairing } from '../src/telegram.js';
const database = readTestPostgresConfig();
test(
  'authenticated Telegram HTTP pairing binds session, validates confirmation, blocks demo and redacts secrets',
  { skip: !database },
  async () => {
    const admin = new pg.Pool(database),
      schema = `telegram_api_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      ...database,
      options: `-c search_path=${schema}`
    });
    const servers = [];
    try {
      const settings = createSettingsStore({
        pool,
        appSecret: randomBytes(32).toString('hex')
      });
      await settings.init();
      const token = '123456789:synthetic_token_12345678901234567890';
      await settings.setSecret('notifications.telegram.botToken', 'telegram', token);
      let command,
        externalCalls = 0;
      const fetchImpl = async (url) => {
        externalCalls++;
        const method = url.split('/').at(-1);
        assert.ok(!['sendMessage', 'setWebhook', 'deleteWebhook'].includes(method));
        return Response.json({
          ok: true,
          result:
            method === 'getMe'
              ? { is_bot: true, username: 'dolphinoTestBot' }
              : method === 'getWebhookInfo'
                ? { url: '' }
                : method === 'getChat'
                  ? {
                      id: -987654321,
                      title: 'Synthetic household',
                      type: 'group'
                    }
                  : [
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
        });
      };
      const telegram = createTelegramPairing({ pool, settings, fetchImpl });
      const config = {
        mode: 'live',
        origin: 'https://dolphino.test',
        host: '127.0.0.1',
        port: 0,
        bootstrapToken: randomBytes(32).toString('base64'),
        sessionSecret: randomBytes(32).toString('hex')
      };
      async function launch(config) {
        const auth = createHouseholdAuth({ pool, config });
        await auth.init();
        if (config.mode === 'live') {
          await auth.bootstrap(
            { headers: {}, socket: { remoteAddress: '127.0.0.1' } },
            {
              email: 'admin@example.test',
              name: 'Fictional admin',
              password: 'synthetic test password',
              bootstrapToken: config.bootstrapToken
            }
          );
        }
        const app = createApp({ store: { pool }, config, telegram, auth });
        const server = await new Promise((resolve) => {
          const s = app.start(() => resolve(s));
        });
        servers.push(server);
        return `http://127.0.0.1:${server.address().port}`;
      }
      const base = await launch(config);
      async function login() {
        const response = await fetch(base + '/api/login', {
          method: 'POST',
          headers: { Origin: config.origin },
          body: JSON.stringify({
            email: 'admin@example.test',
            password: 'synthetic test password'
          })
        });
        assert.equal(response.status, 200);
        return response.headers.get('set-cookie').split(';')[0];
      }
      const cookie = await login(),
        otherCookie = await login();
      const request = (path, { method = 'POST', value = {}, auth = cookie, origin = config.origin, url = base } = {}) =>
        fetch(url + path, {
          method,
          headers: {
            Cookie: auth,
            Origin: origin,
            'Content-Type': 'application/json'
          },
          ...(method === 'GET' ? {} : { body: JSON.stringify(value) })
        });
      assert.equal((await request('/api/settings/telegram/pair', { auth: '' })).status, 401);
      assert.equal(
        (
          await request('/api/settings/telegram/pair', {
            origin: 'https://attacker.test'
          })
        ).status,
        403
      );
      const startResponse = await request('/api/settings/telegram/pair');
      assert.equal(startResponse.status, 200);
      const started = await startResponse.json();
      command = started.command;
      assert.ok(!JSON.stringify(started).includes(token));
      assert.equal((await request('/api/settings/telegram/poll', { auth: otherCookie })).status, 409);
      const poll = await request('/api/settings/telegram/poll');
      assert.equal(poll.status, 200);
      const candidate = await poll.json();
      assert.equal(candidate.candidate.chatId, '-987654321');
      assert.ok(!JSON.stringify(candidate).includes(token));
      assert.ok(!JSON.stringify(candidate).includes(command.split(' ')[1]));
      const statusOther = await (
        await request('/api/settings/telegram/pair', {
          method: 'GET',
          auth: otherCookie
        })
      ).json();
      assert.equal(statusOther.candidate, null);
      assert.equal(
        (
          await request('/api/settings/telegram/confirm', {
            value: { pairingId: started.pairingId, chatId: '-1' }
          })
        ).status,
        409
      );
      const confirm = await request('/api/settings/telegram/confirm', {
        value: {
          pairingId: started.pairingId,
          chatId: candidate.candidate.chatId
        }
      });
      assert.equal(confirm.status, 200, await confirm.text());
      assert.equal((await settings.getValue('notifications.telegram')).enabled, true);
      assert.equal(
        (
          await request('/api/settings/telegram/confirm', {
            value: {
              pairingId: started.pairingId,
              chatId: candidate.candidate.chatId
            }
          })
        ).status,
        409
      );
      const demo = await launch({ ...config, mode: 'demo' }),
        before = externalCalls;
      assert.equal((await request('/api/settings/telegram/pair', { url: demo, auth: '' })).status, 409);
      assert.equal(externalCalls, before);
    } finally {
      await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  }
);
