import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { readTestPostgresConfig } from './helpers/postgres.mjs';
import { Store } from '../src/lib/store.mjs';

test('upgrade from pre-manual schema preserves feed IDs, raw evidence, overrides, categories, grants and budgets across repeated migrations', async () => {
  const config = readTestPostgresConfig();
  assert.ok(config, 'Disposable PostgreSQL required');
  const admin = new pg.Pool(config),
    schema = `manual_upgrade_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ ...config, options: `-c search_path=${schema}` });
  try {
    const dir = new URL('../migrations/', import.meta.url);
    for (const file of (await readdir(dir)).filter((name) => /^\d{3}_.*\.sql$/.test(name) && name < '016_').sort()) {
      await pool.query(await readFile(new URL(file, dir), 'utf8'));
    }

    const id = randomUUID(),
      budget = randomUUID(),
      actor = randomUUID();
    await pool.query(
      "INSERT INTO accounts(mode,id,name,currency,balance_minor,local_label) VALUES('live','old-feed','Provider label','AUD',9007199254740993,'My account')"
    );
    await pool.query(
      "INSERT INTO transactions(id,mode,account_id,currency,amount_minor,status,date,description,kind,fetched_at) VALUES($1,'live','old-feed','AUD',-12345,'posted','2026-09-12','Original','expense',now())",
      [id]
    );
    await pool.query(
      "INSERT INTO provider_observations(mode,provider,account_id,source_id,transaction_id,fetched_at,payload,fingerprint) VALUES('live','redbark','old-feed','source-one',$1,now(),'{\"raw\":{\"amount\":-123.45,\"category\":\"travel\"}}','preserved')",
      [id]
    );
    await pool.query("INSERT INTO source_aliases VALUES('live','redbark','old-feed','source-one',$1)", [id]);
    await pool.query(
      "INSERT INTO transaction_overrides(transaction_id,category,note) VALUES($1,'Travel','Human correction')",
      [id]
    );
    await pool.query("INSERT INTO transaction_tags VALUES($1,'work')", [id]);
    await pool.query(
      "INSERT INTO budgets(id,mode,category,currency,month,cap_minor) VALUES($1,'live','Travel','AUD','2026-09',15000)",
      [budget]
    );
    await pool.query("INSERT INTO user_account_grants VALUES($1,'live','old-feed','edit')", [actor]);
    const names = [
      'transactions',
      'provider_observations',
      'source_aliases',
      'transaction_overrides',
      'transaction_tags',
      'budgets',
      'user_account_grants'
    ];
    const before = {};
    for (const name of names) {
      before[name] = (await pool.query(`SELECT to_jsonb(t) row FROM ${name} t`)).rows;
    }

    const store = new Store(pool, { mode: 'live', timezone: 'Etc/UTC' });
    await store.migrate();
    await store.migrate();
    for (const name of names) {
      const after = (
        await pool.query(
          `SELECT to_jsonb(t) ${name === 'transactions' ? "- 'manual_entry_id' - 'voided_at'" : ''} row FROM ${name} t`
        )
      ).rows;
      assert.deepEqual(after, before[name], `${name} preserved`);
    }

    const account = (await store.listAccounts())[0];
    assert.equal(account.sourceType, 'feed');
    assert.equal(account.name, 'My account');
    assert.equal(account.balanceMinor, '9007199254740993');
    const report = await store.report({ month: '2026-09', currency: 'AUD' });
    assert.equal(report.expensesMinor, '12345');
    assert.equal(report.budgets[0].remainingMinor, '2655');
    await assert.rejects(pool.query("UPDATE provider_observations SET payload='{}'"), /immutable/);
    await assert.rejects(pool.query('DELETE FROM provider_observations'), /immutable/);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
