import { readPostgresConfig } from '../../src/lib/postgres-config.mjs';

// Test processes may use a disposable URL as a convenience. Production entrypoints
// receive only the same explicit PG* inputs used by deployment configuration.
export function testPostgresEnv(env = process.env) {
  const result = {};
  for (const key of [
    'PGHOST',
    'PGPORT',
    'PGDATABASE',
    'PGUSER',
    'PGPASSWORD',
    'PGPASSWORD_FILE',
    'PGSSLMODE',
    'PGSSLROOTCERT',
    'PGOPTIONS'
  ]) {
    if (env[key] !== undefined) {
      result[key] = env[key];
    }
  }

  if (env.TEST_DATABASE_URL) {
    let url;
    try {
      url = new URL(env.TEST_DATABASE_URL);
      if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hash) {
        throw Error('Invalid test URL');
      }

      result.PGHOST = url.hostname.replace(/^\[|\]$/g, '');
      result.PGPORT = url.port || '5432';
      result.PGDATABASE = decodeURIComponent(url.pathname.slice(1));
      if (url.username) {
        result.PGUSER = decodeURIComponent(url.username);
      }

      if (url.password) {
        result.PGPASSWORD = decodeURIComponent(url.password);
        delete result.PGPASSWORD_FILE;
      }

      const queryKeys = { sslmode: 'PGSSLMODE', sslrootcert: 'PGSSLROOTCERT', options: 'PGOPTIONS' };
      for (const [key, value] of url.searchParams) {
        if (!Object.hasOwn(queryKeys, key)) {
          throw Error('Unsupported test URL option');
        }

        result[queryKeys[key]] = value;
      }
    } catch {
      throw Error('TEST_DATABASE_URL must be a valid PostgreSQL test URL with supported connection options');
    }
  }

  return result;
}

export function readTestPostgresConfig(env = process.env) {
  if (!env.TEST_DATABASE_URL && ![env.PGHOST, env.PGDATABASE, env.PGUSER].some(Boolean)) {
    return null;
  }

  const postgresEnv = testPostgresEnv(env);
  return {
    ...readPostgresConfig(postgresEnv),
    ...(postgresEnv.PGOPTIONS ? { options: postgresEnv.PGOPTIONS } : {})
  };
}
