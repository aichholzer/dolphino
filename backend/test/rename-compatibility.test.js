import { readTestPostgresConfig } from './helpers/postgres.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createCipheriv, hkdfSync, createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import pg from 'pg';
import { readConfig } from '../src/config.js';
import { decryptSecret, encryptSecret } from '../src/crypto.js';
import { createHouseholdAuth, householdSessionToken } from '../src/household-auth.js';

test('dolphino env names preserve Profe aliases and reject conflicting secret/plain settings without disclosing values', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dolphino-compat-'));
  const key = randomBytes(32).toString('base64');
  const path = join(dir, 'bootstrap');
  writeFileSync(path, key, { mode: 0o600 });
  try {
    const base = {
      PGHOST: 'localhost',
      PGDATABASE: 'test',
      PGUSER: 'synthetic',
      PGPASSWORD: 'synthetic-only',
      APP_ORIGIN: 'https://dolphino.example.invalid'
    };
    const legacy = readConfig({
      ...base,
      PROFE_MODE: 'live',
      PROFE_BOOTSTRAP_TOKEN_FILE: path,
      PROFE_CURRENCY: 'USD',
      PROFE_TIMEZONE: 'UTC'
    });
    const current = readConfig({
      ...base,
      DOLPHINO_MODE: 'live',
      DOLPHINO_BOOTSTRAP_TOKEN_FILE: path,
      DOLPHINO_CURRENCY: 'USD',
      DOLPHINO_TIMEZONE: 'UTC'
    });
    assert.deepEqual(legacy, current);
    assert.equal(current.bootstrapToken, key);
    assert.equal(readConfig({ ...base, DOLPHINO_MODE: 'live', PROFE_MODE: 'live' }).mode, 'live');
    assert.throws(() => readConfig({ ...base, DOLPHINO_MODE: 'live', PROFE_MODE: 'demo' }), /Conflicting/);
    assert.throws(
      () =>
        readConfig({
          ...base,
          DOLPHINO_CURRENCY: 'AUD',
          PROFE_CURRENCY: 'USD'
        }),
      /Conflicting/
    );
    assert.throws(
      () =>
        readConfig({
          ...base,
          DOLPHINO_BOOTSTRAP_TOKEN_FILE: path,
          PROFE_BOOTSTRAP_TOKEN: 'synthetic-conflict'
        }),
      (e) => e.message.includes('Conflicting') && !e.message.includes(key) && !e.message.includes('synthetic-conflict')
    );
    assert.throws(
      () =>
        readConfig({
          ...base,
          DOLPHINO_BOOTSTRAP_TOKEN_FILE: path,
          DOLPHINO_BOOTSTRAP_TOKEN: 'synthetic-conflict'
        }),
      /Conflicting/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('historical Profe crypto domains decrypt unchanged after branding rename', () => {
  const secret = randomBytes(32).toString('base64'),
    nonce = randomBytes(12),
    salt = randomBytes(32);
  for (const version of [1, 2]) {
    // Historical protocol constants are deliberately fixed; never mechanically rename this fixture.
    const key = Buffer.from(
      hkdfSync(
        'sha256',
        Buffer.from(secret),
        version === 1 ? Buffer.from('profe/settings/key/v1') : salt,
        Buffer.from(
          version === 1
            ? 'AES-256-GCM credential encryption'
            : 'profe/settings/key/v2/AES-256-GCM credential encryption'
        ),
        32
      )
    );
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.from(JSON.stringify(['profe-credential', version, 'llm.apiKey', 'openai'])));
    const data = Buffer.concat([cipher.update('synthetic-legacy-provider-secret'), cipher.final()]);
    const envelope = {
      v: version,
      nonce: nonce.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: data.toString('base64'),
      ...(version === 2 ? { salt: salt.toString('base64') } : {})
    };
    assert.equal(decryptSecret(envelope, secret, 'llm.apiKey', 'openai'), 'synthetic-legacy-provider-secret');
  }
  const fresh = encryptSecret('synthetic-new', secret, 'assistant.llm.apiKey', 'openai');
  assert.equal(decryptSecret(fresh, secret, 'assistant.llm.apiKey', 'openai'), 'synthetic-new');
});
test('cookie migration accepts legacy, prefers new, and does not fall back from malformed new cookie', () => {
  const token = randomBytes(32).toString('base64url'),
    other = randomBytes(32).toString('base64url');
  const request = (cookie) => ({ headers: { cookie } });
  assert.equal(householdSessionToken(request(`profe_session=${token}`)), token);
  assert.equal(householdSessionToken(request(`dolphino_session=${other}; profe_session=${token}`)), other);
  assert.equal(householdSessionToken(request(`dolphino_session=bad; profe_session=${token}`)), null);
  assert.equal(householdSessionToken(request(`dolphino_session=${token}; dolphino_session=${token}`)), null);
});
test('restore accepts old confirmation, uses new name, and refuses conflicting aliases before running client', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dolphino-restore-compat-'));
  writeFileSync(join(dir, 'pg_restore'), "#!/bin/sh\nprintf 'mock-restore-only\\n'\n", { mode: 0o700 });
  const script = resolve('scripts/restore.sh');
  const run = (extra) =>
    spawnSync('/bin/sh', [script, 'synthetic-backup.dump'], {
      encoding: 'utf8',
      env: { PATH: dir, PGDATABASE: 'synthetic_restore', ...extra }
    });
  try {
    for (const setting of [
      { PROFE_RESTORE_CONFIRM: 'synthetic_restore' },
      { DOLPHINO_RESTORE_CONFIRM: 'synthetic_restore' },
      {
        DOLPHINO_RESTORE_CONFIRM: 'synthetic_restore',
        PROFE_RESTORE_CONFIRM: 'synthetic_restore'
      }
    ]) {
      const result = run(setting);
      assert.equal(result.status, 0);
      assert.match(result.stdout, /mock-restore-only/);
    }
    const conflict = run({
      DOLPHINO_RESTORE_CONFIRM: 'synthetic_restore',
      PROFE_RESTORE_CONFIRM: 'other'
    });
    assert.notEqual(conflict.status, 0);
    assert.ok(!conflict.stdout.includes('mock-restore-only'));
    assert.match(conflict.stderr, /Conflicting/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
const database = readTestPostgresConfig();
test(
  'legacy persisted sessions remain valid; logout clears both cookie names and revokes current database token',
  { skip: !database },
  async () => {
    const admin = new pg.Pool(database);
    const schema = `rename_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      ...database,
      options: `-c search_path=${schema}`
    });
    const auth = createHouseholdAuth({ pool, config: { mode: 'live' } });
    try {
      await auth.init();
      const user = (
        await pool.query(
          "INSERT INTO household_users(email,name,role,password_hash) VALUES('legacy@example.invalid','Synthetic legacy','admin','synthetic-unused-hash') RETURNING id"
        )
      ).rows[0];
      const token = randomBytes(32).toString('base64url');
      await pool.query(
        "INSERT INTO household_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",
        [createHash('sha256').update(token).digest('hex'), user.id]
      );
      const req = { headers: { cookie: `profe_session=${token}` } };
      assert.equal((await auth.session(req)).id, user.id);
      assert.equal(
        (
          await auth.session({
            headers: { cookie: `dolphino_session=${token}` }
          })
        ).id,
        user.id
      );
      const logout = await auth.logout(req);
      assert.equal(logout.cookie.length, 2);
      assert.ok(logout.cookie.some((v) => v.startsWith('dolphino_session=;') && v.includes('Max-Age=0')));
      assert.ok(logout.cookie.some((v) => v.startsWith('profe_session=;') && v.includes('Max-Age=0')));
      assert.equal(await auth.session(req), null);
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  }
);
