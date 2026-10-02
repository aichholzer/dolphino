import { readTestPostgresConfig } from './helpers/postgres.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { ensureDeploymentMode } from '../src/lib/deployment-mode.mjs';
const database = readTestPostgresConfig();
test(
  'deployment mode binds atomically and rejects legacy live/demo confusion without changing data',
  { skip: !database },
  async () => {
    const owner = new pg.Pool(database);
    const schemas = [];
    const pools = [];
    async function isolated() {
      const schema = `mode_${randomUUID().replaceAll('-', '')}`;
      schemas.push(schema);
      await owner.query(`CREATE SCHEMA ${schema}`);
      const pool = new pg.Pool({
        ...database,
        options: `-c search_path=${schema}`
      });
      pools.push(pool);
      return pool;
    }

    try {
      const fresh = await isolated();
      const race = await Promise.allSettled([ensureDeploymentMode(fresh, 'live'), ensureDeploymentMode(fresh, 'demo')]);
      assert.equal(race.filter((r) => r.status === 'fulfilled').length, 1);
      const mode = (await fresh.query('SELECT mode FROM deployment_mode')).rows[0].mode;
      await ensureDeploymentMode(fresh, mode);
      await assert.rejects(ensureDeploymentMode(fresh, mode === 'live' ? 'demo' : 'live'), /different deployment mode/);
      for (const table of ['accounts', 'household_users', 'encrypted_credentials']) {
        const legacy = await isolated();
        await legacy.query(
          table === 'accounts'
            ? "CREATE TABLE accounts(mode text); INSERT INTO accounts VALUES('live')"
            : `CREATE TABLE ${table}(id text); INSERT INTO ${table} VALUES('synthetic')`
        );
        await assert.rejects(ensureDeploymentMode(legacy, 'demo'), /cannot safely enter/);
        assert.equal((await legacy.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count, 1);
        assert.equal((await legacy.query("SELECT to_regclass('deployment_mode') AS name")).rows[0].name, null);
        await ensureDeploymentMode(legacy, 'live');
      }

      const demo = await isolated();
      await demo.query("CREATE TABLE accounts(mode text); INSERT INTO accounts VALUES('demo')");
      await assert.rejects(ensureDeploymentMode(demo, 'live'), /cannot safely enter/);
      await ensureDeploymentMode(demo, 'demo');
    } finally {
      for (const pool of pools) {
        await pool.end();
      }

      for (const schema of schemas) {
        await owner.query(`DROP SCHEMA ${schema} CASCADE`);
      }

      await owner.end();
    }
  }
);
