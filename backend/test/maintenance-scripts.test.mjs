import { readTestPostgresConfig } from './helpers/postgres.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { Store } from '../src/lib/store.mjs';
import { ensureDeploymentMode } from '../src/lib/deployment-mode.mjs';
import { createHouseholdAuth, hashHouseholdPassword, verifyHouseholdPassword } from '../src/lib/household-auth.mjs';
import { ensureAccessSchema } from '../src/lib/access.mjs';
import { createUserManagement } from '../src/lib/users.mjs';
import { createSettingsStore } from '../src/lib/settings.mjs';
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

test(
  'rotate-settings-key re-encrypts every credential under the new key and never prints one',
  { skip: !database },
  async () => {
    await withSchema('rotate_key', async ({ schema, pool }) => {
      const oldKey = randomBytes(48).toString('base64url'),
        newKey = randomBytes(48).toString('base64url');
      const before = createSettingsStore({ pool, appSecret: oldKey });
      await before.init();
      const secrets = [
        ['llm.apiKey', 'openai', 'synthetic-openai-key-value'],
        ['notifications.smtp.url', 'smtp', 'smtps://synthetic:secret@smtp.example.test:465'],
        ['redbark.apiKey', 'redbark', 'synthetic-redbark-key-value']
      ];
      for (const [setting, provider, value] of secrets) {
        await before.setSecret(setting, provider, value);
      }

      const ciphertexts = async () =>
        (await pool.query('SELECT ciphertext FROM encrypted_credentials ORDER BY setting')).rows.map(
          (r) => r.ciphertext
        );
      const original = await ciphertexts();
      const dir = await mkdtemp(join(tmpdir(), 'dolphino-rotate-'));
      try {
        const oldFile = join(dir, 'old'),
          newFile = join(dir, 'new'),
          weakFile = join(dir, 'weak');
        await writeFile(oldFile, `${oldKey}\n`, { mode: 0o600 });
        await writeFile(newFile, `${newKey}\n`, { mode: 0o600 });
        await writeFile(weakFile, 'changeme\n', { mode: 0o600 });
        const rotate = (env) => run('scripts/rotate-settings-key.mjs', [], childEnv(schema, env)).exited;

        for (const env of [{}, { APP_SECRET_FILE: oldFile }, { NEW_APP_SECRET_FILE: newFile }]) {
          const result = await rotate(env);
          assert.equal(result.code, 1);
          assert.match(result.stderr, /Provide APP_SECRET_FILE and NEW_APP_SECRET_FILE/);
        }

        for (const env of [
          { APP_SECRET_FILE: oldFile, NEW_APP_SECRET_FILE: weakFile },
          { APP_SECRET_FILE: newFile, NEW_APP_SECRET_FILE: oldFile }
        ]) {
          const result = await rotate(env);
          assert.equal(result.code, 1, 'a weak new key or the wrong old key changes nothing');
          assert.deepEqual(await ciphertexts(), original);
        }

        const result = await rotate({ APP_SECRET_FILE: oldFile, NEW_APP_SECRET_FILE: newFile });
        assert.equal(result.code, 0, result.stderr);
        assert.match(result.stdout, /^Rotated 3 encrypted credentials\. Install the new APP_SECRET before restarting/);
        for (const text of [oldKey, newKey, ...secrets.map(([, , value]) => value)]) {
          assert.ok(!result.stdout.includes(text) && !result.stderr.includes(text), 'no key or secret is printed');
        }

        const after = createSettingsStore({ pool, appSecret: newKey });
        for (const [setting, provider, value] of secrets) {
          assert.equal(await after.getSecret(setting, provider), value);
          await assert.rejects(before.getSecret(setting, provider), /Encrypted credentials unavailable/);
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
);
