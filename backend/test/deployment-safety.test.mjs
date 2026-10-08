import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfig } from '../src/lib/config.mjs';
import { householdSessionToken } from '../src/lib/household-auth.mjs';

const database = {
  PGHOST: 'localhost',
  PGDATABASE: 'synthetic_config',
  PGUSER: 'synthetic_config',
  PGPASSWORD: 'synthetic-only',
  APP_ORIGIN: 'https://dolphino.example.invalid'
};

test('canonical deployment values accept secret files and reject conflicting direct values safely', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dolphino-deployment-'));
  const key = randomBytes(32).toString('base64');
  const filename = join(directory, 'bootstrap');
  writeFileSync(filename, key, { mode: 0o600 });
  try {
    const value = readConfig({
      ...database,
      DOLPHINO_MODE: 'live',
      DOLPHINO_BOOTSTRAP_TOKEN_FILE: filename,
      DOLPHINO_BOOTSTRAP_TOKEN: key,
      DOLPHINO_CURRENCY: 'USD',
      DOLPHINO_TIMEZONE: 'UTC'
    });
    assert.equal(value.mode, 'live');
    assert.equal(value.bootstrapToken, key);
    assert.equal(value.currency, 'USD');
    assert.equal(value.timezone, 'UTC');
    assert.throws(
      () =>
        readConfig({
          ...database,
          DOLPHINO_BOOTSTRAP_TOKEN_FILE: filename,
          DOLPHINO_BOOTSTRAP_TOKEN: 'synthetic-conflict'
        }),
      (error) =>
        error.message.includes('Conflicting') &&
        !error.message.includes(key) &&
        !error.message.includes('synthetic-conflict')
    );
    const queried = [];
    readConfig(
      new Proxy(database, {
        get: (target, name) => {
          queried.push(name);
          return target[name];
        }
      })
    );
    const allowed = /^(?:DOLPHINO_|PG|APP_|HOST$|PORT$|TRUST_PROXY$|DATABASE_URL)/;
    assert(
      queried.every((name) => allowed.test(String(name))),
      'Only documented deployment names are read'
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('session cookies accept only one valid canonical token', () => {
  const token = randomBytes(32).toString('base64url');
  const request = (cookie) => ({ headers: { cookie } });
  assert.equal(householdSessionToken(request(`dolphino_session=${token}`)), token);
  assert.equal(householdSessionToken(request(`unrelated_session=${token}; dolphino_session=${token}`)), token);
  for (const cookie of [
    '',
    `unrelated_session=${token}`,
    `dolphino_session=bad; unrelated_session=${token}`,
    `dolphino_session=${token}; dolphino_session=${token}`,
    `dolphino_session=${token}=`,
    `dolphino_session=${token}%00`
  ]) {
    assert.equal(householdSessionToken(request(cookie)), null);
  }
});
