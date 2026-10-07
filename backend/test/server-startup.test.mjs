import { readTestPostgresConfig } from './helpers/postgres.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { childEnv, freePort, run } from './helpers/child.mjs';
const database = readTestPostgresConfig();
const listening = /dolphino (demo|live) listening on port \d+/;

async function withSchema(name, fn) {
  const admin = new pg.Pool(database),
    schema = `${name}_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  try {
    return await fn(schema);
  } finally {
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
}

async function start(schema, overrides) {
  const port = await freePort();
  const server = run(
    'backend/src/server.mjs',
    [],
    childEnv(schema, { HOST: '127.0.0.1', PORT: String(port), ...overrides }),
    { ready: listening }
  );
  try {
    await server.ready;
  } catch (error) {
    assert.fail(`server did not start: ${error.stderr || error.stdout}`);
  }

  return { ...server, url: `http://127.0.0.1:${port}`, port };
}

async function stop(server, signal) {
  server.child.kill(signal);
  const result = await server.exited;
  assert.deepEqual([result.code, result.signal], [0, null], `${signal} exits cleanly: ${result.stderr}`);
}

test('demo server starts from the environment, serves the API and stops on SIGTERM', { skip: !database }, async () => {
  await withSchema('server_demo', async (schema) => {
    const server = await start(schema, { DOLPHINO_CURRENCY: 'NZD', DOLPHINO_TIMEZONE: 'Pacific/Auckland' });
    assert.match(server.output.stdout, new RegExp(`dolphino demo listening on port ${server.port}`));
    let response = await fetch(`${server.url}/api/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('strict-transport-security'), null, 'no HSTS over plain demo HTTP');
    response = await fetch(`${server.url}/api/session`);
    const session = await response.json();
    assert.equal(session.demo, true);
    assert.equal(session.currency, 'NZD');
    assert.equal(session.timeZone, 'Pacific/Auckland');
    assert.equal(session.user.role, 'admin');
    response = await fetch(`${server.url}/api/settings/provider`);
    assert.equal(response.status, 200, 'shared AI settings are wired');
    response = await fetch(`${server.url}/api/users/invitations`, {
      method: 'POST',
      headers: { Origin: 'http://localhost:3001' },
      body: JSON.stringify({ email: 'x@example.test', role: 'member' })
    });
    assert.equal(response.status, 409, 'demo refuses sensitive actions');
    await stop(server, 'SIGTERM');

    const live = run(
      'backend/src/server.mjs',
      [],
      childEnv(schema, {
        HOST: '127.0.0.1',
        PORT: String(await freePort()),
        DOLPHINO_MODE: 'live',
        APP_ORIGIN: 'https://dolphino.test'
      })
    );
    const refused = await live.exited;
    assert.notEqual(refused.code, 0, 'a demo database never starts a live server');
    assert.match(refused.stderr, /Database is bound to a different deployment mode/);
    assert.ok(!listening.test(refused.stdout));
  });
});

test(
  'live server bootstraps the first administrator over HTTPS settings and stops on SIGINT',
  { skip: !database },
  async () => {
    await withSchema('server_live', async (schema) => {
      const bootstrapToken = randomBytes(32).toString('base64url');
      const server = await start(schema, {
        DOLPHINO_MODE: 'live',
        APP_ORIGIN: 'https://dolphino.test',
        APP_SECRET: randomBytes(48).toString('base64url'),
        DOLPHINO_BOOTSTRAP_TOKEN: bootstrapToken
      });
      let response = await fetch(`${server.url}/api/session`);
      assert.equal(response.headers.get('strict-transport-security'), 'max-age=31536000');
      const session = await response.json();
      assert.equal(session.demo, false);
      assert.equal(session.authenticated, false);
      assert.equal(session.setupRequired, true);
      assert.equal((await fetch(`${server.url}/api/settings/provider`)).status, 401);
      response = await fetch(`${server.url}/api/auth/bootstrap`, {
        method: 'POST',
        headers: { Origin: 'https://dolphino.test' },
        body: JSON.stringify({
          email: 'admin@example.test',
          name: 'Admin',
          password: 'synthetic household password',
          bootstrapToken
        })
      });
      assert.equal(response.status, 200);
      const cookie = response.headers.get('set-cookie').split(';')[0];
      response = await fetch(`${server.url}/api/users`, { headers: { Cookie: cookie } });
      assert.equal(response.status, 200);
      assert.deepEqual(
        (await response.json()).users.map((u) => [u.email, u.role]),
        [['admin@example.test', 'admin']]
      );
      response = await fetch(`${server.url}/api/settings/provider`, { headers: { Cookie: cookie } });
      assert.equal(response.status, 200);
      await stop(server, 'SIGINT');
    });
  }
);

test('invalid deployment settings stop the server before it listens', { skip: !database }, async () => {
  await withSchema('server_invalid', async (schema) => {
    for (const [overrides, message] of [
      [{ DOLPHINO_MODE: 'staging' }, /DOLPHINO_MODE must be demo or live/],
      [{ DOLPHINO_MODE: 'live', APP_ORIGIN: 'http://dolphino.test' }, /live mode requires HTTPS/],
      [{ DOLPHINO_CURRENCY: 'dollars' }, /Invalid currency/]
    ]) {
      const result = await run('backend/src/server.mjs', [], childEnv(schema, { HOST: '127.0.0.1', ...overrides }))
        .exited;
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, message);
      assert.ok(!listening.test(result.stdout));
    }
  });
});
