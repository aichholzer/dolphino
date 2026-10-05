import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { guardPool } from '../src/lib/db.mjs';
import { Store } from '../src/lib/store.mjs';
import { readTestPostgresConfig } from './helpers/postgres.mjs';

const database = readTestPostgresConfig();

// Terminate whichever backend is running the marked statement, from a separate connection.
async function terminate(admin, marker) {
  for (let i = 0; i < 100; i++) {
    const { rowCount } = await admin.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND query LIKE $1',
      [`%${marker}%`]
    );
    if (rowCount) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw Error('The marked statement never started');
}

test(
  'a connection lost on a checked-out client rejects the query and the process survives',
  { skip: !database },
  async () => {
    const errors = [];
    const pool = guardPool(new pg.Pool({ ...database, max: 2 }), (error) => errors.push(error.message));
    const admin = new pg.Pool({ ...database });
    try {
      const client = await pool.connect();
      const marker = `lost_${randomUUID().replaceAll('-', '')}`;
      const closed = new Promise((resolve) => client.once('end', resolve));
      const pending = client.query(`SELECT pg_sleep(10) AS ${marker}`);
      await terminate(admin, marker);
      await assert.rejects(pending, /terminat/i);
      // The unhandled 'error' that used to exit Node is emitted when the socket closes.
      await closed;
      client.release(true);
      assert.ok(errors.length >= 1, 'the guard listener received the connection error');
      assert.equal((await pool.query('SELECT 1 AS ok')).rows[0].ok, 1, 'the pool keeps serving');
    } finally {
      await pool.end();
      await admin.end();
    }
  }
);

test(
  'a transaction whose connection is lost reports the original error and frees its client',
  { skip: !database },
  async () => {
    const schema = `connection_loss_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ ...database });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = guardPool(new pg.Pool({ ...database, max: 2, options: `-c search_path=${schema}` }), () => {});
    try {
      const store = new Store(pool, { mode: 'live' });
      await store.migrate();
      const marker = `atomic_${randomUUID().replaceAll('-', '')}`;
      const pending = store.atomic((c) => c.query(`SELECT pg_sleep(10) AS ${marker}`), { refresh: false });
      await terminate(admin, marker);
      await assert.rejects(pending, (error) => {
        assert.match(error.message, /terminat/i, 'the lost connection is reported, not the failed ROLLBACK');
        return true;
      });
      assert.equal((await store.atomic((c) => c.query('SELECT 1 AS ok'), { refresh: false })).rows[0].ok, 1);
      assert.equal(pool.totalCount - pool.idleCount, 0, 'no client stays checked out');
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  }
);
