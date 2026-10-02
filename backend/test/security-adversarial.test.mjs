import { readTestPostgresConfig, testPostgresEnv } from './helpers/postgres.mjs';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ensureDeploymentMode } from '../src/lib/deployment-mode.mjs';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { chromium } from '@playwright/test';
import { Store } from '../src/lib/store.mjs';
import { createApp } from '../src/app.mjs';
import { createHouseholdAuth } from '../src/lib/household-auth.mjs';
import { validateAndSetGrants } from '../src/lib/access.mjs';
import { smtpOptions, sendSmtp } from '../src/lib/notifications.mjs';
import { publicSmtpAddress } from '../src/lib/smtp-network.mjs';

// No external requests: DNS and SMTP transports are deliberately hostile mocks.
test('SMTP SSRF blocks literals, private/mixed DNS and pins checked public address with TLS hostname', async () => {
  for (const host of [
    '127.0.0.1',
    '169.254.169.254',
    '[::1]',
    'localhost',
    'relay.home',
    'relay.local',
    'relay.internal'
  ]) {
    assert.throws(() => smtpOptions(`smtps://synthetic:synthetic@${host}:465`));
  }

  for (const address of [
    '0.0.0.0',
    '127.1.2.3',
    '10.1.2.3',
    '172.16.1.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '198.18.0.1',
    '224.0.0.1',
    '::1',
    '::ffff:127.0.0.1',
    'fd00::1',
    'fe80::1',
    '2001:db8::1',
    '2002:7f00:1::1'
  ]) {
    assert.equal(publicSmtpAddress(address), false, address);
  }

  const input = {
    smtpUrl: 'smtps://synthetic:synthetic@smtp-relay.brevo.com:465',
    from: 'synthetic@example.com',
    to: 'synthetic@example.com',
    text: 'Synthetic only'
  };
  let transports = 0;
  for (const addresses of [[], [{ address: '127.0.0.1' }], [{ address: '8.8.8.8' }, { address: '169.254.169.254' }]]) {
    await assert.rejects(
      sendSmtp(
        input,
        () => {
          transports++;
          throw Error('must not connect');
        },
        async () => addresses
      ),
      /SMTP delivery failed/
    );
  }

  assert.equal(transports, 0);
  let options;
  let lookups = 0;
  await sendSmtp(
    input,
    (value) => {
      options = value;
      return { sendMail: async () => {}, close() {} };
    },
    async () => {
      lookups++;
      return [{ address: '8.8.8.8', family: 4 }];
    }
  );
  assert.equal(lookups, 1);
  assert.equal(options.host, '8.8.8.8');
  assert.equal(options.servername, 'smtp-relay.brevo.com');
  assert.equal(options.tls.servername, 'smtp-relay.brevo.com');
  assert.equal(options.tls.rejectUnauthorized, true);
  assert.equal(options.requireTLS, true);
});

const database = readTestPostgresConfig();
test(
  'independent live HTTP role, CSRF, proxy, injection, static headers and actual Chromium XSS probes',
  { skip: !database, timeout: 60000 },
  async () => {
    const owner = new pg.Pool(database);
    const schema = `security_${randomUUID().replaceAll('-', '')}`;
    await owner.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      ...database,
      options: `-c search_path=${schema}`
    });
    let server, browser;
    try {
      const store = new Store(pool, { mode: 'live' });
      await store.migrate();
      const config = {
        mode: 'live',
        host: '127.0.0.1',
        port: 0,
        origin: 'https://dolphino.test',
        currency: 'AUD',
        timezone: 'Australia/Brisbane',
        bootstrapToken: randomBytes(32).toString('base64')
      };
      const auth = createHouseholdAuth({ pool, config });
      await auth.init();
      const created = await auth.bootstrap(
        { headers: {}, socket: { remoteAddress: 'fixture' } },
        {
          email: 'synthetic-admin@example.com',
          name: 'Synthetic admin',
          password: 'synthetic long password',
          bootstrapToken: config.bootstrapToken
        }
      );
      const id = (
        await pool.query(
          "INSERT INTO household_users(email,name,role,password_hash) SELECT 'synthetic-member@example.com','Synthetic member','member',password_hash FROM household_users WHERE id=$1 RETURNING id",
          [created.user.id]
        )
      ).rows[0].id;
      const member = await auth.login(
        { headers: {}, socket: { remoteAddress: 'fixture' } },
        {
          email: 'synthetic-member@example.com',
          password: 'synthetic long password'
        }
      );
      const attack = '<img src=x onerror="window.__dolphinoXss=1"><script>window.__dolphinoXss=1</script>';
      const tx = await store.ingest({
        sourceId: 'visible',
        accountId: 'visible',
        currency: 'AUD',
        amountMinor: '-100',
        status: 'posted',
        date: new Date().toISOString().slice(0, 10),
        category: 'Other',
        kind: 'expense',
        description: attack
      });
      await store.correctTransaction(tx.id, { note: attack });
      await store.atomic(
        (c) => validateAndSetGrants(c, id, { accounts: [{ accountId: 'visible', access: 'view' }] }, { mode: 'live' }),
        { refresh: false }
      );
      const app = createApp({
        store,
        config,
        auth,
        integration: {},
        classification: {},
        assistantSettings: {
          getUserStatus: async () => ({
            available: false,
            reason: 'not configured'
          })
        }
      });
      server = await new Promise((resolve) => {
        const s = app.start(() => resolve(s));
      });
      const base = `http://127.0.0.1:${server.address().port}`;
      const cookie = member.cookie.split(';')[0];
      const request = (
        path,
        { method = 'GET', authenticated = true, origin = config.origin, body, headers = {} } = {}
      ) =>
        fetch(base + path, {
          method,
          headers: {
            ...(authenticated ? { Cookie: cookie } : {}),
            ...(origin ? { Origin: origin } : {}),
            ...headers
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) })
        });
      const oversized = await request('/api/webhooks/redbark', {
        method: 'POST',
        authenticated: false,
        origin: null,
        body: { data: 'x'.repeat(1048576) }
      });
      assert.equal(oversized.status, 413, 'raw webhook body is bounded before provider processing');
      const bootstrapBody = {
        email: 'attacker@example.com',
        name: 'Attacker',
        password: 'synthetic long password',
        bootstrapToken: 'forged'
      };
      assert.equal(
        (
          await request('/api/auth/bootstrap', {
            method: 'POST',
            authenticated: false,
            body: bootstrapBody
          })
        ).status,
        403
      );
      assert.equal(
        (
          await request('/api/auth/bootstrap', {
            method: 'POST',
            authenticated: false,
            body: { ...bootstrapBody, bootstrapToken: config.bootstrapToken }
          })
        ).status,
        409
      );
      const responses = [];
      for (let attempt = 0; attempt < 11; attempt++) {
        const response = await request('/api/login', {
          method: 'POST',
          authenticated: false,
          body: {
            email: attempt % 2 ? 'synthetic-member@example.com' : 'missing@example.com',
            password: 'x'.repeat(129)
          },
          // Loopback is a trusted proxy: it appends the actual untrusted client
          // after any attacker-supplied prefix, which must not control the key.
          headers: { 'X-Forwarded-For': `192.0.2.${attempt},203.0.113.77` }
        });
        responses.push({
          status: response.status,
          body: await response.json()
        });
      }

      assert.deepEqual(responses[0], responses[1], 'login does not enumerate existing identities');
      assert(responses.slice(0, 10).every((response) => response.status === 401));
      assert.equal(responses[10].status, 429, 'rotating untrusted forwarding prefixes cannot bypass rate limit');
      assert.match(created.cookie, /HttpOnly; SameSite=Strict/);
      assert.match(created.cookie, /; Secure/);
      // Protected routes are rejected before their missing services can execute.
      const adminRoutes = [
        ['GET', '/api/users'],
        ['GET', '/api/users/grant-options'],
        ['POST', '/api/users/invitations'],
        ['POST', `/api/users/invitations/${randomUUID()}/resend`],
        ['POST', `/api/users/invitations/${randomUUID()}/revoke`],
        ['PATCH', `/api/users/${id}`],
        ['POST', `/api/users/${id}/reset-password`],
        ['GET', '/api/settings'],
        ['GET', '/api/settings/ai'],
        ['PUT', '/api/settings/ai'],
        ['POST', '/api/settings/ai/models'],
        ['POST', '/api/settings/ai/test-connection'],
        ['GET', '/api/settings/provider'],
        ['PUT', '/api/settings/provider'],
        ['POST', '/api/settings/provider/test-connection'],
        ['POST', '/api/settings/provider/test-model'],
        ['GET', '/api/settings/assistant'],
        ['PUT', '/api/settings/assistant'],
        ['POST', '/api/settings/assistant/test-connection'],
        ['POST', '/api/settings/assistant/test-model'],
        ['GET', '/api/settings/webhook'],
        ['POST', '/api/settings/webhook/register'],
        ['POST', '/api/settings/webhook/test'],
        ['GET', '/api/import-health'],
        ['POST', '/api/import-health/backfill'],
        ['POST', '/api/import-health/retry'],
        ['GET', '/api/settings/notifications'],
        ['PUT', '/api/settings/notifications'],
        ['POST', '/api/notifications/test'],
        ['GET', '/api/notifications/deliveries'],
        ['POST', `/api/notifications/${randomUUID()}/retry`],
        ['GET', '/api/settings/telegram/pair'],
        ['POST', '/api/settings/telegram/pair'],
        ['POST', '/api/settings/telegram/poll'],
        ['POST', '/api/settings/telegram/confirm'],
        ['POST', '/api/connection/test'],
        ['GET', '/api/rules'],
        ['POST', '/api/rules'],
        ['DELETE', `/api/rules/${randomUUID()}`],
        ['POST', `/api/transactions/${tx.id}/suggest`]
      ];
      for (const [method, path] of adminRoutes) {
        assert.equal(
          (
            await request(path, {
              method,
              body: method === 'GET' ? undefined : {},
              authenticated: false
            })
          ).status,
          401,
          `anonymous ${method} ${path}`
        );
        assert.equal(
          (
            await request(path, {
              method,
              body: method === 'GET' ? undefined : {}
            })
          ).status,
          403,
          `member ${method} ${path}`
        );
      }

      for (const path of [
        '/api/accounts',
        '/api/transactions',
        '/api/budgets',
        '/api/export',
        '/api/dashboard',
        '/api/reviews',
        '/api/assistant/chats'
      ]) {
        assert.equal((await request(path, { authenticated: false })).status, 401, path);
      }

      for (const origin of [undefined, 'null', 'https://dolphino.test.attacker.invalid', 'https://attacker.invalid']) {
        const headers = {
          Cookie: cookie,
          ...(origin ? { Origin: origin } : {})
        };
        const response = await fetch(base + '/api/logout', {
          method: 'POST',
          headers
        });
        assert.equal(response.status, 403, `CSRF origin ${origin}`);
      }

      assert.equal(
        (
          await request(`/api/transactions/${tx.id}`, {
            method: 'PATCH',
            body: {
              category: 'Hacked',
              userId: created.user.id,
              role: 'admin'
            }
          })
        ).status,
        400
      );
      assert.equal(
        (
          await request(`/api/transactions/${tx.id}`, {
            method: 'PATCH',
            body: { category: 'Hacked' }
          })
        ).status,
        404
      );
      const query = encodeURIComponent("' OR 1=1; DROP TABLE household_users;--");
      const injection = await request(`/api/transactions?allHistory=true&search=${query}`);
      assert.equal(injection.status, 200);
      assert.equal((await injection.json()).transactions.length, 0);
      assert.equal((await pool.query('SELECT count(*)::int n FROM household_users')).rows[0].n, 2);
      const duplicate = await request('/api/session', {
        headers: { Cookie: cookie + '; ' + cookie }
      });
      assert.equal((await duplicate.json()).authenticated, false);
      const forged = await request('/api/session', {
        authenticated: false,
        headers: {
          'X-Forwarded-User': created.user.id,
          'X-Forwarded-For': '127.0.0.1',
          'X-Forwarded-Proto': 'https',
          Authorization: 'Bearer forged'
        }
      });
      assert.equal((await forged.json()).authenticated, false);
      const api = await request('/api/accounts');
      assert.equal(api.headers.get('access-control-allow-origin'), null);
      assert.equal(api.headers.get('cache-control'), 'no-store');
      assert.equal(api.headers.get('x-content-type-options'), 'nosniff');
      const html = await fetch(base);
      assert.equal(html.status, 200);
      assert.match(
        html.headers.get('content-security-policy'),
        /base-uri 'none'.*object-src 'none'.*form-action 'self'/
      );
      assert.equal(html.headers.get('referrer-policy'), 'no-referrer');
      assert.equal(html.headers.get('strict-transport-security'), 'max-age=31536000');
      for (const path of ['/.env', '/backend/src/lib/config.mjs', '/%2e%2e%2f.env', '/.git/config']) {
        assert.equal((await fetch(base + path)).status, 404, path);
      }

      // Real Chromium renders hostile ledger text from this real HTTP/PG app.
      browser = await chromium.launch({
        executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
        args: ['--no-sandbox']
      });
      const context = await browser.newContext();
      await context.addCookies([
        {
          name: 'dolphino_session',
          value: cookie.split('=')[1],
          url: base,
          httpOnly: true,
          sameSite: 'Strict'
        }
      ]);
      const page = await context.newPage();
      const external = [];
      await page.route('**/*', (route) => {
        if (!route.request().url().startsWith(base)) {
          external.push(route.request().url());
          return route.abort();
        }

        return route.continue();
      });
      await page.goto(base);
      await page.getByRole('button', { name: 'Transactions', exact: true }).first().click();
      await page.getByText(attack, { exact: true }).first().waitFor();
      assert.equal(await page.evaluate(() => globalThis.__dolphinoXss), undefined);
      assert.equal(await page.locator('img[src="x"]').count(), 0);
      assert.equal(await page.getByRole('button', { name: 'Settings', exact: true }).count(), 0);
      assert.equal(external.length, 0);
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(await page.evaluate(() => globalThis.__dolphinoXss), undefined);
      await browser.close();
      browser = undefined;
      const logout = await request('/api/logout', { method: 'POST', body: {} });
      assert.equal(logout.status, 200);
      assert.equal((await request('/api/accounts')).status, 401);
    } finally {
      await browser?.close();
      if (server) {
        await new Promise((resolve) => server.close(resolve));
      }

      await pool.end();
      await owner.query(`DROP SCHEMA ${schema} CASCADE`);
      await owner.end();
    }
  }
);

test(
  'production entrypoints refuse demo over a live-bound database before migrations or serving',
  { skip: !database, timeout: 15000 },
  async () => {
    const owner = new pg.Pool(database);
    const schema = `entry_security_${randomUUID().replaceAll('-', '')}`;
    await owner.query(`CREATE SCHEMA ${schema}`);
    const options = `-c search_path=${schema}`;
    const pool = new pg.Pool({ ...database, options });
    try {
      await ensureDeploymentMode(pool, 'live');
      for (const entry of ['backend/src/server.mjs', 'backend/src/utils/migrate.mjs', 'backend/src/utils/seed.mjs']) {
        await assert.rejects(
          promisify(execFile)(process.execPath, [entry], {
            cwd: process.cwd(),
            timeout: 5000,
            env: {
              PATH: process.env.PATH,
              DOLPHINO_MODE: 'demo',
              ...testPostgresEnv(),
              PGOPTIONS: options,
              HOST: '127.0.0.1',
              PORT: '0'
            }
          }),
          (error) => error.code === 1 && /different deployment mode/.test(error.stderr),
          entry
        );
        assert.equal(
          (await pool.query('SELECT count(*)::int n FROM information_schema.tables WHERE table_schema=$1', [schema]))
            .rows[0].n,
          1,
          'no app/auth/integration schemas were initialized'
        );
        assert.equal((await pool.query('SELECT mode FROM deployment_mode')).rows[0].mode, 'live');
      }
    } finally {
      await pool.end();
      await owner.query(`DROP SCHEMA ${schema} CASCADE`);
      await owner.end();
    }
  }
);
