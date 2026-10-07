import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { readTestPostgresConfig } from '../../backend/test/helpers/postgres.mjs';
import { childEnv, freePort, root, run } from '../../backend/test/helpers/child.mjs';

// Runs every frontend/test/*.browser.mjs in turn. The demo checks get a freshly seeded demo
// server on its own schema; the others start their own servers or use the test database.
// Needs the PG* test database variables, a build in frontend/dist and Chromium (CHROMIUM_PATH).
// Arguments filter the scripts by name: node frontend/test/browser-suite.mjs auth theme
const database = readTestPostgresConfig();
if (!database) {
  console.error('Set PGHOST, PGDATABASE, PGUSER (or TEST_DATABASE_URL) for a disposable PostgreSQL database.');
  process.exit(1);
}

if (!existsSync(resolve(root, 'frontend/dist/index.html'))) {
  console.error('Build the frontend first: npm run build');
  process.exit(1);
}

const filters = process.argv.slice(2);
const scripts = readdirSync(resolve(root, 'frontend/test'))
  .filter((file) => file.endsWith('.browser.mjs') && (!filters.length || filters.some((name) => file.includes(name))))
  .sort();
const schema = `browser_demo_${randomUUID().replaceAll('-', '')}`;
const admin = new pg.Pool(database);
await admin.query(`CREATE SCHEMA ${schema}`);
const failed = [];
let server;
try {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const demo = childEnv(schema, { DOLPHINO_MODE: 'demo', APP_ORIGIN: url, HOST: '127.0.0.1', PORT: String(port) });
  const seeded = await run('backend/src/utils/seed.mjs', [], demo).exited;
  if (seeded.code !== 0) {
    throw Error(`Seeding the demo failed:\n${seeded.stderr}`);
  }

  server = run('backend/src/server.mjs', [], demo, { ready: /listening on port/ });
  await server.ready;
  for (const script of scripts) {
    const started = Date.now();
    const result = await run(`frontend/test/${script}`, [], { ...process.env, DOLPHINO_TEST_URL: url }).exited;
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    if (result.code === 0) {
      console.log(`pass  ${script} (${seconds} s)`);
    } else {
      failed.push(script);
      console.log(`FAIL  ${script} (${seconds} s, exit ${result.code ?? result.signal})`);
      console.log(`${result.stdout}${result.stderr}`.trim().replace(/^/gm, '      '));
    }
  }
} finally {
  if (server) {
    server.child.kill('SIGTERM');
    await server.exited;
  }

  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
}

console.log(`${scripts.length - failed.length} of ${scripts.length} browser checks passed`);
process.exitCode = failed.length ? 1 : 0;
