import { readTestPostgresConfig } from './helpers/postgres.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { Store } from '../src/lib/store.mjs';
import { createHouseholdAuth } from '../src/lib/household-auth.mjs';
import { createUserManagement } from '../src/lib/users.mjs';
import { createApp } from '../src/app.mjs';
const database = readTestPostgresConfig();
const tokenFrom = (mail) => mail.text.match(/#token=([A-Za-z0-9_-]+)/)[1];

test(
  'HTTP user management: access policy, strict bodies, demo refusal, rate limit and every admin action',
  { skip: !database },
  async () => {
    const admin = new pg.Pool(database),
      schema = `users_http_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      ...database,
      options: `-c search_path=${schema}`
    });
    const servers = [];
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
      const mail = [];
      const users = createUserManagement({
        pool,
        config,
        settings: {
          getValue: async () => ({ from: 'dolphino@example.test' }),
          getSecret: async () => 'smtps://synthetic:synthetic@smtp.example.test:465'
        },
        sendMail: async (message) => {
          mail.push(message);
        }
      });
      await users.init();
      const password = 'synthetic household password';
      const root = await auth.bootstrap(
        { headers: {}, socket: { remoteAddress: 'test' } },
        { email: 'admin@example.test', name: 'Admin', password, bootstrapToken: config.bootstrapToken }
      );
      await pool.query(
        "INSERT INTO accounts(id,mode,name,currency) VALUES('acct_test','live','Synthetic account','AUD')"
      );
      // Each app owns a fresh sensitive-action limiter of five calls a minute per action.
      const serve = async (appConfig = config) => {
        const app = createApp({ store, config: appConfig, auth, users, integration: {}, classification: {} });
        const server = await new Promise((resolve) => {
          const s = app.start(() => resolve(s));
        });
        servers.push(server);
        const url = `http://127.0.0.1:${server.address().port}`;
        return (cookie, path, method = 'GET', value, { origin = config.origin } = {}) =>
          fetch(url + path, {
            method,
            headers: { ...(cookie ? { Cookie: cookie } : {}), ...(origin ? { Origin: origin } : {}) },
            ...(value === undefined ? {} : { body: JSON.stringify(value) })
          });
      };

      const cookieOf = (response) => response.headers.get('set-cookie').split(';')[0];
      const adminCookie = root.cookie.split(';')[0];
      const invitations = async () =>
        (await pool.query('SELECT count(*)::int AS n FROM household_invitations')).rows[0].n;
      const audit = async (action) =>
        (await pool.query('SELECT count(*)::int AS n FROM household_security_audit WHERE action=$1', [action])).rows[0]
          .n;

      let request = await serve();
      const actions = [
        ['GET', '/api/users'],
        ['GET', '/api/users/grant-options'],
        ['POST', '/api/users/invitations', { email: 'x@example.test', role: 'member' }],
        ['POST', `/api/users/invitations/${randomUUID()}/resend`],
        ['POST', `/api/users/invitations/${randomUUID()}/revoke`],
        ['PATCH', `/api/users/${root.user.id}`, { role: 'admin' }],
        ['POST', `/api/users/${root.user.id}/reset-password`]
      ];
      for (const [method, path, value] of actions) {
        const response = await request(null, path, method, value);
        assert.equal(response.status, 401, `${method} ${path} signed out`);
        assert.deepEqual(await response.json(), { error: 'Sign in required' });
      }

      for (const [method, path, value] of actions.filter(([method]) => method !== 'GET')) {
        const response = await request(adminCookie, path, method, value, { origin: null });
        assert.equal(response.status, 403, `${method} ${path} without Origin`);
        assert.deepEqual(await response.json(), { error: 'Origin not allowed' });
        assert.equal(
          (await request(adminCookie, path, method, value, { origin: 'https://evil.example' })).status,
          403,
          `${method} ${path} from a foreign Origin`
        );
      }

      assert.equal(await invitations(), 0, 'refused requests create nothing');

      // Invitations: strict body, address validation, then the limiter on the sixth call.
      const invite = (value) => request(adminCookie, '/api/users/invitations', 'POST', value);
      let response = await invite({ email: 'member@example.test', role: 'member', note: 'extra' });
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: 'Invalid request fields' });
      assert.equal((await invite({ email: 'member@example.test', role: 'owner' })).status, 400);
      assert.equal((await invite({ email: `${'a'.repeat(250)}@example.test`, role: 'member' })).status, 400);
      assert.equal((await invite({ email: 'not an address', role: 'member' })).status, 400);
      response = await invite({
        email: ' Member@Example.Test ',
        role: 'member',
        grants: { accounts: [{ accountId: 'acct_test', access: 'view' }], budgets: [] }
      });
      assert.equal(response.status, 200);
      const memberInvite = await response.json();
      assert.equal(memberInvite.email, 'member@example.test');
      assert.equal(memberInvite.role, 'member');
      assert.equal(memberInvite.purpose, 'invite');
      assert.equal(memberInvite.deliveryState, 'sent');
      assert.deepEqual(memberInvite.grants, { accounts: [{ accountId: 'acct_test', access: 'view' }], budgets: [] });
      assert.equal(mail.length, 1);
      assert.equal(mail[0].to, 'member@example.test');
      assert.match(mail[0].text, /^You have been invited to dolphino\./);
      assert.match(mail[0].text, /https:\/\/dolphino\.test\/activate#token=/);
      const memberToken = tokenFrom(mail[0]);
      assert.ok(!JSON.stringify(memberInvite).includes(memberToken), 'the link never leaves by HTTP');
      response = await invite({ email: 'late@example.test', role: 'member' });
      assert.equal(response.status, 429);
      assert.deepEqual(await response.json(), { error: 'Too many settings requests; retry in one minute' });
      assert.equal(await invitations(), 1);

      // Activation is public and single use.
      response = await request(null, '/api/auth/activate', 'POST', {
        token: memberToken,
        password: 'synthetic member password',
        name: 'Member'
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true });
      response = await request(null, '/api/auth/activate', 'POST', {
        token: memberToken,
        password: 'synthetic member password',
        name: 'Member'
      });
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: 'Link is invalid or expired' });
      assert.equal(
        (await request(null, '/api/auth/activate', 'POST', { token: memberToken, password: 'x', role: 'admin' }))
          .status,
        400,
        'activation refuses unknown fields'
      );
      const login = (email, secret) => request(null, '/api/login', 'POST', { email, password: secret });
      response = await login('member@example.test', 'synthetic member password');
      assert.equal(response.status, 200);
      let memberCookie = cookieOf(response);
      const member = (await pool.query("SELECT id FROM household_users WHERE email='member@example.test'")).rows[0];

      // Members reach none of the administrator actions, and their attempts spend no limiter budget.
      request = await serve();
      for (const [method, path, value] of actions) {
        response = await request(memberCookie, path, method, value);
        assert.equal(response.status, 403, `${method} ${path} as member`);
        assert.deepEqual(await response.json(), { error: 'Administrator access required' });
      }

      response = await request(adminCookie, '/api/users');
      assert.equal(response.status, 200);
      const listed = await response.json();
      assert.deepEqual(
        listed.users.map((u) => [u.email, u.role, u.disabled]),
        [
          ['admin@example.test', 'admin', false],
          ['member@example.test', 'member', false]
        ]
      );
      assert.deepEqual(listed.users[1].grants.accounts, [{ accountId: 'acct_test', access: 'view' }]);
      assert.ok(listed.invitations[0].usedAt);
      assert.ok(!JSON.stringify(listed).includes(memberToken));
      assert.ok(!JSON.stringify(listed).includes('password'));
      response = await request(adminCookie, '/api/users/grant-options');
      assert.deepEqual(await response.json(), {
        accounts: [{ id: 'acct_test', name: 'Synthetic account', currency: 'AUD' }],
        budgets: []
      });

      assert.equal((await invite({ email: 'MEMBER@example.test', role: 'member' })).status, 409, 'existing user');
      response = await invite({ email: 'second@example.test', role: 'admin' });
      const second = await response.json();
      assert.equal(second.role, 'admin');
      assert.deepEqual(second.grants, { accounts: [], budgets: [] }, 'administrators carry no grants');
      const firstSecondToken = tokenFrom(mail.at(-1));

      // Resend issues a fresh link and retires the old one.
      const resend = (id) => request(adminCookie, `/api/users/invitations/${id}/resend`, 'POST');
      response = await resend(second.id);
      assert.equal(response.status, 200);
      const resent = await response.json();
      assert.notEqual(resent.id, second.id);
      assert.equal(resent.email, 'second@example.test');
      assert.equal(resent.role, 'admin');
      const secondToken = tokenFrom(mail.at(-1));
      assert.notEqual(secondToken, firstSecondToken);
      assert.equal(
        (await request(null, '/api/auth/activate', 'POST', { token: firstSecondToken, password, name: 'Second' }))
          .status,
        400
      );
      response = await resend(second.id);
      assert.equal(response.status, 409, 'the replaced invitation cannot be resent');
      assert.deepEqual(await response.json(), { error: 'Invitation unavailable' });
      assert.equal((await resend(randomUUID())).status, 409);
      assert.equal((await resend('not-a-uuid')).status, 400);

      // Revoke is final.
      const revoke = (id) => request(adminCookie, `/api/users/invitations/${id}/revoke`, 'POST');
      response = await revoke(resent.id);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true });
      assert.equal(await audit('invitation_revoked'), 1);
      assert.equal((await revoke(memberInvite.id)).status, 409, 'used invitations cannot be revoked');
      assert.equal((await revoke(randomUUID())).status, 409);
      assert.equal(
        (await request(null, '/api/auth/activate', 'POST', { token: secondToken, password, name: 'Second' })).status,
        400
      );
      assert.equal((await resend(resent.id)).status, 409, 'revoked invitations cannot be resent');
      assert.equal(
        (await pool.query("SELECT 1 FROM household_users WHERE email='second@example.test'")).rowCount,
        0,
        'no revoked or replaced link created an account'
      );

      // Role, disabled and grant changes.
      const update = (id, value) => request(adminCookie, `/api/users/${id}`, 'PATCH', value);
      assert.equal((await update(member.id, { role: 'admin', note: 'extra' })).status, 400);
      assert.equal((await update(member.id, { disabled: 'yes' })).status, 400);
      assert.equal(
        (await update(member.id, { grants: { accounts: [], budgets: [{ budgetId: 'nope', access: 'view' }] } })).status,
        400
      );
      response = await update(root.user.id, { role: 'member' });
      assert.equal(response.status, 409);
      assert.deepEqual(await response.json(), {
        error: 'You cannot demote or disable your own administrator account'
      });
      response = await update(member.id, { role: 'admin' });
      assert.equal(response.status, 200);
      assert.equal(
        (await request(memberCookie, '/api/session').then((r) => r.json())).authenticated,
        false,
        'a role change signs the user out'
      );
      request = await serve();
      assert.equal((await update(randomUUID(), { role: 'member' })).status, 404);
      response = await update(member.id, {
        role: 'member',
        grants: { accounts: [{ accountId: 'acct_test', access: 'edit' }], budgets: [] }
      });
      assert.equal(response.status, 200);
      let grants = (await (await request(adminCookie, '/api/users')).json()).users[1].grants;
      assert.equal(grants.accounts[0].access, 'edit');
      response = await update(member.id, { disabled: true });
      assert.equal(response.status, 200);
      assert.equal((await login('member@example.test', 'synthetic member password')).status, 401);
      response = await request(adminCookie, `/api/users/${member.id}/reset-password`, 'POST');
      assert.equal(response.status, 409, 'disabled users get no reset link');
      assert.deepEqual(await response.json(), { error: 'User unavailable' });
      assert.equal((await update(member.id, { disabled: false })).status, 200);
      grants = (await (await request(adminCookie, '/api/users')).json()).users[1].grants;
      assert.equal(grants.accounts[0].access, 'edit', 'enabling keeps the grants');
      assert.equal(await audit('user_access_updated'), 4);

      // Password reset mails a one-hour link that signs the user out.
      response = await login('member@example.test', 'synthetic member password');
      memberCookie = cookieOf(response);
      response = await request(adminCookie, `/api/users/${member.id}/reset-password`, 'POST');
      assert.equal(response.status, 200);
      const reset = await response.json();
      assert.equal(reset.purpose, 'reset');
      assert.equal(reset.deliveryState, 'sent');
      assert.ok(new Date(reset.expiresAt).getTime() - Date.now() <= 3600000);
      assert.match(mail.at(-1).subject, /Reset your dolphino password/);
      assert.match(mail.at(-1).text, /https:\/\/dolphino\.test\/reset-password#token=/);
      const resetToken = tokenFrom(mail.at(-1));
      assert.equal(
        (await request(adminCookie, `/api/users/${randomUUID()}/reset-password`, 'POST')).status,
        409,
        'unknown user'
      );
      response = await request(null, '/api/auth/activate', 'POST', {
        token: resetToken,
        password: 'synthetic changed password'
      });
      assert.equal(response.status, 200);
      assert.equal((await request(memberCookie, '/api/session').then((r) => r.json())).authenticated, false);
      assert.equal((await login('member@example.test', 'synthetic member password')).status, 401);
      assert.equal((await login('member@example.test', 'synthetic changed password')).status, 200);

      // Demo mode refuses every sensitive action before it reads the body or touches the database.
      const before = await invitations(),
        sent = mail.length;
      request = await serve({ ...config, mode: 'demo' });
      for (const [method, path, value] of actions.filter(([method]) => method !== 'GET')) {
        response = await request(adminCookie, path, method, value);
        assert.equal(response.status, 409, `${method} ${path} in demo mode`);
        assert.deepEqual(await response.json(), {
          error: 'Credential settings and external actions require authenticated live mode'
        });
      }

      assert.equal(await invitations(), before);
      assert.equal(mail.length, sent);
    } finally {
      for (const server of servers) {
        await new Promise((resolve) => server.close(resolve));
      }

      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  }
);
