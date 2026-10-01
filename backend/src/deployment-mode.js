// Installation-level guard: a demo process must never expose live users/settings.
// Ledger mode columns alone cannot isolate shared credentials and authentication.
export async function ensureDeploymentMode(pool, mode) {
  if (!['demo', 'live'].includes(mode)) {
    throw Error('Invalid deployment mode');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(17092401)');
    await client.query(`CREATE TABLE IF NOT EXISTS deployment_mode (
      singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
      mode text NOT NULL CHECK(mode IN ('demo','live')),
      bound_at timestamptz NOT NULL DEFAULT now()
    )`);
    const existing = (await client.query('SELECT mode FROM deployment_mode WHERE singleton=true')).rows[0];
    if (existing) {
      if (existing.mode !== mode) {
        throw Error('Database is bound to a different deployment mode. Use a separate database; no data was changed.');
      }
    } else {
      let live = false,
        demo = false,
        credentials = false;
      for (const table of ['accounts', 'transactions', 'budgets']) {
        if ((await client.query('SELECT to_regclass($1) AS name', [table])).rows[0].name) {
          const rows = (await client.query(`SELECT DISTINCT mode FROM ${table}`)).rows;
          live ||= rows.some((row) => row.mode === 'live');
          demo ||= rows.some((row) => row.mode === 'demo');
        }
      }
      for (const table of ['household_users', 'encrypted_credentials']) {
        if ((await client.query('SELECT to_regclass($1) AS name', [table])).rows[0].name) {
          const any = (await client.query(`SELECT EXISTS(SELECT 1 FROM ${table}) AS present`)).rows[0].present;
          if (table === 'household_users') {
            live ||= any;
          } else {
            credentials ||= any;
          }
        }
      }
      if ((mode === 'demo' && (live || credentials)) || (mode === 'live' && demo)) {
        throw Error(
          'Existing database contents cannot safely enter this deployment mode. Keep live and demo databases separate; no data was changed.'
        );
      }
      await client.query('INSERT INTO deployment_mode(singleton,mode) VALUES(true,$1)', [mode]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
