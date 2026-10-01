import { readTestPostgresConfig } from './helpers/postgres.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomUUID, randomBytes } from 'node:crypto';
import { createHouseholdAuth, hashHouseholdPassword, verifyHouseholdPassword } from '../src/household-auth.js';
import { readConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { Store } from '../src/store.js';
const database = readTestPostgresConfig();
test('household password hashes use random salts and reject wrong password', async () => {
  const a = await hashHouseholdPassword('a long fictional password');
  assert.notEqual(a, await hashHouseholdPassword('a long fictional password'));
  assert(await verifyHouseholdPassword('a long fictional password', a));
  assert(!(await verifyHouseholdPassword('wrong', a)));
});
test('live mode fails closed without session protection or HTTPS', () => {
  assert.throws(() =>
    readConfig({
      DOLPHINO_MODE: 'live',
      PGHOST: 'localhost',
      PGDATABASE: 'test',
      PGUSER: 'synthetic',
      PGPASSWORD: 'synthetic-only'
    })
  );
  assert.throws(() => readConfig({ DOLPHINO_MODE: 'demo' }));
});
test(
  'household HTTP setup, login, server sessions and route guards reject legacy shared access',
  { skip: !database },
  async (t) => {
    const admin = new pg.Pool(database),
      schema = `auth_api_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      ...database,
      options: `-c search_path=${schema}`
    });
    t.after(async () => {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    });
    const config = {
      host: '127.0.0.1',
      port: 0,
      mode: 'live',
      origin: 'https://dolphino.test',
      currency: 'AUD',
      timezone: 'Australia/Brisbane',
      sessionSecret: randomBytes(32).toString('hex'),
      bootstrapToken: randomBytes(32).toString('base64'),
      passwordHash: `scrypt:${'0'.repeat(32)}:${'0'.repeat(128)}`
    };
    const auth = createHouseholdAuth({ pool, config });
    await auth.init();
    const store = new Store(pool, { mode: 'live' });
    await store.migrate();
    const realAccounts = store.listAccounts.bind(store);
    let failAccounts = true;
    store.listAccounts = async (...args) => {
      if (failAccounts) {
        throw Error('secret db password');
      }
      return realAccounts(...args);
    };
    const app = createApp({ config, store, integration: {}, auth });
    const server = await new Promise((resolve) => {
      const s = app.start(() => resolve(s));
    });
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    const request = (path, value, headers = {}) =>
      fetch(base + path, {
        method: 'POST',
        headers: { Origin: config.origin, ...headers },
        body: JSON.stringify(value)
      });
    assert.equal((await fetch(base + '/api/accounts')).status, 401);
    assert.equal((await fetch(base + '/api/login', { method: 'POST', body: '{}' })).status, 403);
    assert.notEqual((await request('/api/login', { password: 'retired shared password' })).status, 200);
    // Bootstrap deliberately uses a synthetic setup token; the browser must not infer one.
    const setup = {
      email: 'admin@example.test',
      name: 'Fictional admin',
      password: 'fictional long test password',
      bootstrapToken: config.bootstrapToken
    };
    assert.notEqual(
      (
        await request('/api/auth/bootstrap', {
          ...setup,
          bootstrapToken: 'wrong'
        })
      ).status,
      200
    );
    const created = await request('/api/auth/bootstrap', setup);
    assert.equal(created.status, 200, await created.text());
    assert.notEqual((await request('/api/auth/bootstrap', setup)).status, 200);
    const login = await request('/api/login', {
      email: setup.email,
      password: setup.password
    });
    assert.equal(login.status, 200);
    const cookieHeader = login.headers.get('set-cookie');
    assert.match(cookieHeader, /Secure/);
    assert.match(cookieHeader, /HttpOnly/);
    assert.match(cookieHeader, /SameSite=Strict/);
    const cookie = cookieHeader.split(';')[0];
    assert.equal(
      (
        await fetch(base + '/api/accounts', {
          headers: { Cookie: cookie + 'tampered' }
        })
      ).status,
      401
    );
    const failure = await fetch(base + '/api/accounts', {
      headers: { Cookie: cookie }
    });
    assert.equal(failure.status, 500);
    assert.ok(!(await failure.text()).includes('password'));
    failAccounts = false;
    assert.equal(
      (
        await fetch(base + '/api/transactions/x', {
          method: 'PATCH',
          headers: { Origin: config.origin, Cookie: cookie },
          body: JSON.stringify({
            category: '',
            splits: [{ category: 'X', amountMinor: 1.5 }]
          })
        })
      ).status,
      400
    );
    await pool.query(
      "INSERT INTO household_users(email,name,role,password_hash) SELECT 'member@example.test','Fictional member','member',password_hash FROM household_users WHERE email=$1",
      [setup.email]
    );
    const memberLogin = await request('/api/login', {
      email: 'member@example.test',
      password: setup.password
    });
    assert.equal(memberLogin.status, 200);
    const memberCookie = memberLogin.headers.get('set-cookie').split(';')[0];
    for (const path of ['/api/settings/provider', '/api/users']) {
      assert.equal((await fetch(base + path, { headers: { Cookie: memberCookie } })).status, 403, path);
    }
    const memberAccounts = await (await fetch(base + '/api/accounts', { headers: { Cookie: memberCookie } })).json();
    assert.deepEqual(memberAccounts.accounts, []);
    const memberTransactions = await (
      await fetch(base + '/api/transactions', {
        headers: { Cookie: memberCookie }
      })
    ).json();
    assert.deepEqual(memberTransactions.transactions, []);
    const memberReport = await (
      await fetch(base + '/api/dashboard', {
        headers: { Cookie: memberCookie }
      })
    ).json();
    assert.equal(memberReport.expensesMinor, '0');
    const memberSession = await (await fetch(base + '/api/session', { headers: { Cookie: memberCookie } })).json();
    assert.equal(memberSession.user.role, 'member');
    assert.equal((await request('/api/logout', {}, { Cookie: cookie })).status, 200);
    assert.equal((await fetch(base + '/api/accounts', { headers: { Cookie: cookie } })).status, 401);
  }
);
