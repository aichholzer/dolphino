import { readTestPostgresConfig } from './helpers/postgres.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { Store } from '../src/lib/store.mjs';
import { ensureDeploymentMode } from '../src/lib/deployment-mode.mjs';
import { createHouseholdAuth, hashHouseholdPassword, verifyHouseholdPassword } from '../src/lib/household-auth.mjs';
import { ensureAccessSchema } from '../src/lib/access.mjs';
import { createUserManagement } from '../src/lib/users.mjs';
import { childEnv, run } from './helpers/child.mjs';
const database = readTestPostgresConfig();

async function withSchema(name, fn) {
  const admin = new pg.Pool(database),
    schema = `${name}_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ ...database, options: `-c search_path=${schema}` });
  try {
    return await fn({ schema, pool });
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
}

test(
  'recover-user prints one reset link for an active live user and refuses everything else',
  { skip: !database },
  async () => {
    await withSchema('recover_user', async ({ schema, pool }) => {
      const config = { mode: 'live', origin: 'https://dolphino.test' };
      await new Store(pool, { mode: 'live' }).migrate();
      await ensureDeploymentMode(pool, 'live');
      await createHouseholdAuth({ pool, config }).init();
      await ensureAccessSchema(pool);
      const users = createUserManagement({ pool, config, settings: null });
      await users.init();
      const passwordHash = await hashHouseholdPassword('synthetic old password');
      await pool.query(
        "INSERT INTO household_users(email,name,role,password_hash) VALUES('member@example.test','Member','member',$1),('gone@example.test','Gone','member',$1)",
        [passwordHash]
      );
      await pool.query("UPDATE household_users SET disabled=true WHERE email='gone@example.test'");
      const live = childEnv(schema, { DOLPHINO_MODE: 'live', APP_ORIGIN: 'https://dolphino.test' });
      const recover = (args, env = live) => run('scripts/recover-user.mjs', args, env).exited;
      const failure =
        'Recovery link could not be created. Check the email, live database, migrated schema and HTTPS application origin.';

      for (const args of [[], ['member@example.test'], ['--user', 'member@example.test'], ['--email']]) {
        const result = await recover(args);
        assert.equal(result.code, 1, args.join(' '));
        assert.match(result.stderr, /^Usage: node scripts\/recover-user\.mjs --email user@example\.com/);
        assert.equal(result.stdout, '');
      }

      for (const [args, env] of [
        [['--email', 'member@example.test'], childEnv(schema, { DOLPHINO_MODE: 'demo' })],
        [['--email', 'nobody@example.test'], live],
        [['--email', 'gone@example.test'], live],
        [['--email', 'not an address'], live],
        [['--email', 'member@example.test'], { ...live, APP_ORIGIN: 'https://dolphino.test/path' }]
      ]) {
        const result = await recover(args, env);
        assert.equal(result.code, 1, `${args[1]} ${env.DOLPHINO_MODE} ${env.APP_ORIGIN}`);
        assert.equal(result.stderr.trim(), failure);
        assert.equal(result.stdout, '');
      }

      assert.equal((await pool.query('SELECT 1 FROM household_invitations')).rowCount, 0);
      const result = await recover(['--email', ' Member@Example.Test ']);
      assert.equal(result.code, 0, result.stderr);
      const [notice, link, ...rest] = result.stdout.trim().split('\n');
      assert.match(notice, /^One-use password reset link, expires in one hour\. Treat as a secret/);
      assert.match(link, /^https:\/\/dolphino\.test\/reset-password#token=[A-Za-z0-9_-]{43}$/);
      assert.deepEqual(rest, []);
      const invitation = (await pool.query('SELECT * FROM household_invitations')).rows[0];
      assert.equal(invitation.delivery_state, 'operator');
      assert.equal(invitation.purpose, 'reset');
      assert.ok(new Date(invitation.expires_at).getTime() - Date.now() <= 3600000);
      assert.equal(
        (await pool.query("SELECT 1 FROM household_security_audit WHERE action='recovery_link_created'")).rowCount,
        1
      );
      const token = link.split('#token=')[1];
      await users.activate({ token, password: 'synthetic new password' });
      const stored = (await pool.query("SELECT password_hash FROM household_users WHERE email='member@example.test'"))
        .rows[0].password_hash;
      assert.ok(await verifyHouseholdPassword('synthetic new password', stored));
      await assert.rejects(users.activate({ token, password: 'synthetic third password' }), /invalid or expired/);
    });
  }
);
