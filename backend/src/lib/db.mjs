import pg from 'pg';
import { readPostgresConfig } from './postgres-config.mjs';
export async function createPool(env = process.env) {
  return new pg.Pool({
    ...readPostgresConfig(env),
    max: 10,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000
  });
}
