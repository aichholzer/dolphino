import test from 'node:test';
import assert from 'node:assert/strict';
import { readTestPostgresConfig, testPostgresEnv } from './helpers/postgres.mjs';

const fields = {
  PGHOST: '127.0.0.1',
  PGPORT: '55432',
  PGDATABASE: 'synthetic_test',
  PGUSER: 'synthetic',
  PGPASSWORD: 'synthetic-only-password'
};

test('test database helper uses explicit PG fields and skips when none are configured', () => {
  assert.equal(readTestPostgresConfig({}), null);
  assert.equal(readTestPostgresConfig({ DATABASE_URL: 'postgresql://unused.invalid/ignored' }), null);
  const config = readTestPostgresConfig(fields);
  assert.equal(config.host, fields.PGHOST);
  assert.equal(config.port, 55432);
  assert.equal(config.database, fields.PGDATABASE);
  assert.equal(config.user, fields.PGUSER);
  assert.equal(config.password, fields.PGPASSWORD);
  assert.throws(() => readTestPostgresConfig({ PGHOST: '127.0.0.1' }));
});

test('test URL selects the disposable database rather than inherited admin database', () => {
  const env = {
    ...fields,
    PGDATABASE: 'postgres',
    DATABASE_URL: 'postgresql://unused.invalid/legacy',
    DATABASE_URL_FILE: '/must/not/read',
    PGPASSWORD_FILE: '/must/not/read',
    TEST_DATABASE_URL: 'postgresql://test_user:synthetic%3Apassword@localhost:55433/disposable_test'
  };
  const childEnv = testPostgresEnv(env);
  assert.deepEqual(childEnv, {
    PGHOST: 'localhost',
    PGPORT: '55433',
    PGDATABASE: 'disposable_test',
    PGUSER: 'test_user',
    PGPASSWORD: 'synthetic:password'
  });
  const config = readTestPostgresConfig(env);
  assert.equal(config.database, 'disposable_test');
  assert.equal(config.password, 'synthetic:password');
});

test('test database child environment contains only PG inputs and preserves schema isolation', () => {
  const env = {
    ...fields,
    TEST_DATABASE_URL: 'postgresql://synthetic:synthetic-only@127.0.0.1/disposable?options=-c%20search_path%3Disolated',
    SOME_OTHER_SECRET: 'must-not-propagate'
  };
  const childEnv = testPostgresEnv(env);
  assert.equal(childEnv.PGPORT, '5432');
  assert.equal(childEnv.PGOPTIONS, '-c search_path=isolated');
  assert.equal(childEnv.SOME_OTHER_SECRET, undefined);
  assert.equal(childEnv.TEST_DATABASE_URL, undefined);
  assert.equal(readTestPostgresConfig(env).options, '-c search_path=isolated');
});

test('invalid test URL errors do not expose the supplied URL or secret', () => {
  for (const value of [
    'invalid-synthetic-secret',
    'https://user:synthetic-secret@localhost/test',
    'postgresql://user:synthetic-secret@localhost/test?unsupported=1'
  ]) {
    assert.throws(
      () => readTestPostgresConfig({ TEST_DATABASE_URL: value }),
      (error) => /TEST_DATABASE_URL/.test(error.message) && !error.message.includes('synthetic-secret')
    );
  }
});
