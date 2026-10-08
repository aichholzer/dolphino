import { readTestPostgresConfig } from './helpers/postgres.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
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
  'rotate-secrets re-encrypts every credential under the new key and never prints one',
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
        const rotate = (env) => run('scripts/rotate-secrets.mjs', [], childEnv(schema, env)).exited;

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
