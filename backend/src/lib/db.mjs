import pg from 'pg';
import { readPostgresConfig } from './postgres-config.mjs';

const reportUnavailable = () => console.error('Database connection unavailable');

// node-postgres drops its own error listener while a client is checked out. A connection lost
// mid-query then emits 'error' with no listener and Node exits, so every client keeps one for life.
// The failed query still rejects, and pg-pool discards the broken client when it is released.
export function guardPool(pool, onError = reportUnavailable) {
  pool.on('error', onError);
  pool.on('connect', (client) => client.on('error', onError));
  return pool;
}

export async function createPool(env = process.env) {
  return guardPool(
    new pg.Pool({
      ...readPostgresConfig(env),
      max: 10,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30000
    })
  );
}
