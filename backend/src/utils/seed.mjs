import pg from 'pg';
import { ensureDeploymentMode } from '../lib/deployment-mode.mjs';
import { readConfig } from '../lib/config.mjs';
import { Store } from '../lib/store.mjs';
const config = readConfig();
if (config.mode !== 'demo') {
  throw Error('Demo fixtures cannot be loaded in live mode');
}

const pool = new pg.Pool(config.database);
try {
  await ensureDeploymentMode(pool, config.mode);
  const store = new Store(pool, { mode: 'demo', timezone: config.timezone });
  await store.migrate();
  await store.seedDemo();
  console.log('Fictional demo fixtures ready');
} finally {
  await pool.end();
}
