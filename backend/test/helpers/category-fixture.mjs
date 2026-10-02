import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import pg from 'pg';
import { readTestPostgresConfig } from './postgres.mjs';
import { Store } from '../../src/lib/store.mjs';
import { createHouseholdAuth } from '../../src/lib/household-auth.mjs';
import { validateAndSetGrants } from '../../src/lib/access.mjs';
import { createApp } from '../../src/app.mjs';

// Real PostgreSQL, real session authorization and real HTTP. No worker or provider
// is started; all fixtures and credentials are synthetic and schema-isolated.
export async function categoryFixture({ appOptions = async () => ({}), databaseTimezone } = {}) {
  const database = readTestPostgresConfig();
  assert.ok(database, 'Configure a disposable PostgreSQL database');
  const admin = new pg.Pool(database);
  const schema = `categories_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({
    ...database,
    options: `-c search_path=${schema}${databaseTimezone ? ` -c timezone=${databaseTimezone}` : ''}`
  });
  let server;
  const close = async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }

    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  };

  try {
    const store = new Store(pool, { mode: 'live', timezone: 'Etc/UTC' });
    await store.migrate();
    const config = {
      mode: 'live',
      host: '127.0.0.1',
      port: 0,
      origin: 'http://127.0.0.1',
      currency: 'AUD',
      timezone: 'Etc/UTC',
      bootstrapToken: randomBytes(32).toString('hex')
    };
    const auth = createHouseholdAuth({ pool, config });
    await auth.init();
    const request = { headers: {}, socket: { remoteAddress: '127.0.0.1' } };
    const password = 'Synthetic category test password';
    const root = await auth.bootstrap(request, {
      email: 'admin@example.test',
      name: 'Admin',
      password,
      bootstrapToken: config.bootstrapToken
    });
    const users = { admin: root.user };
    const cookies = { admin: root.cookie.split(';')[0] };
    for (const name of ['editor', 'viewer', 'budget', 'none']) {
      users[name] = (
        await pool.query(
          "INSERT INTO household_users(email,name,role,password_hash) SELECT $1,$2,'member',password_hash FROM household_users WHERE id=$3 RETURNING id,role",
          [`${name}@example.test`, name, root.user.id]
        )
      ).rows[0];
      cookies[name] = (await auth.login(request, { email: `${name}@example.test`, password })).cookie.split(';')[0];
    }

    const base = {
      accountId: 'visible',
      accountName: 'Everyday',
      currency: 'AUD',
      amountMinor: '-12345',
      status: 'posted',
      date: '2026-09-12',
      fetchedAt: '2026-09-14T00:00:00Z',
      kind: 'expense',
      category: 'Travel'
    };
    const tx = await store.ingest({
      ...base,
      sourceId: 'flight',
      description: 'Train to conference',
      reviewReason: 'Classification review: check travel',
      raw: { category: 'cat_travel', evidence: 'unchanged' }
    });
    const secret = await store.ingest({
      ...base,
      accountId: 'hidden',
      sourceId: 'secret',
      description: 'Hidden merchant',
      category: 'Secret category'
    });
    await store.correctTransaction(secret.id, { tags: ['secret-tag'] });
    const transfer = await store.ingest({
      ...base,
      sourceId: 'transfer',
      description: 'Confidential repayment',
      kind: 'transfer',
      category: 'Secret transfer',
      reviewReason: 'Classification review: repayment'
    });
    await store.correctTransaction(transfer.id, { tags: ['private-transfer-tag'], note: 'Confidential note' });
    const opaque = await store.ingest({
      ...base,
      sourceId: 'opaque',
      description: 'Unresolved purchase',
      category: 'cat_opaque',
      raw: { category: 'cat_opaque' }
    });
    const pending = await store.ingest({
      ...base,
      sourceId: 'pending-pair',
      description: 'Pending hotel',
      category: 'Other',
      amountMinor: '-777',
      status: 'pending',
      date: '2026-09-11'
    });
    const posted = await store.ingest({
      ...base,
      sourceId: 'posted-pair',
      description: 'Posted hotel',
      category: 'Other',
      amountMinor: '-777'
    });
    const split = await store.ingest({ ...base, sourceId: 'split', description: 'Split purchase' });
    await store.correctTransaction(split.id, {
      category: 'Other',
      splits: [
        { category: 'Travel', amountMinor: '-2345' },
        { category: 'Groceries', amountMinor: '-10000' }
      ],
      note: 'Manual split evidence'
    });
    const budget = await store.saveBudget({
      category: 'Travel',
      currency: 'AUD',
      month: '2026-09',
      capMinor: '12000',
      allocationMinor: '100',
      rollover: true
    });
    await store.saveBudget({
      category: 'Travel',
      currency: 'AUD',
      month: '2026-10',
      capMinor: '25000',
      rollover: true
    });
    const grant = (name, value) =>
      store.atomic((c) => validateAndSetGrants(c, users[name].id, value, { mode: 'live' }), { refresh: false });
    await grant('editor', { accounts: [{ accountId: 'visible', access: 'edit' }] });
    await grant('viewer', { accounts: [{ accountId: 'visible', access: 'view' }] });
    await grant('budget', { budgets: [{ budgetId: budget.id, access: 'edit' }] });
    const app = createApp({
      store,
      config,
      auth,
      integration: { status: async () => ({ configured: false }) },
      registration: { status: async () => ({ configured: false, publicBaseUrl: '' }) },
      redbarkSettings: {
        getPublic: async () => ({
          configured: false,
          encryptionAvailable: true,
          version: '2026-10-01.wattle',
          backfillDays: 90
        })
      },
      classification: {
        suggest: async () => {
          throw Error('No external classification allowed');
        }
      },
      assistantSettings: { getUserStatus: async () => ({ enabled: false }) },
      pocketsmith: { status: async () => ({ configured: false, enabled: false, backfillDays: 90, accounts: [] }) },
      ...(await appOptions({ pool, store, config }))
    });
    server = await new Promise((resolve) => {
      const running = app.start(() => resolve(running));
    });
    const url = `http://127.0.0.1:${server.address().port}`;
    config.origin = url;
    const http = async (name, path, method = 'GET', value, origin = url) =>
      fetch(url + path, {
        method,
        headers: {
          ...(cookies[name] ? { Cookie: cookies[name] } : {}),
          Origin: origin,
          'Content-Type': 'application/json'
        },
        ...(value === undefined ? {} : { body: JSON.stringify(value) })
      });
    const json = async (...args) => {
      const response = await http(...args);
      assert.equal(response.status, 200, await response.clone().text());
      return response.json();
    };

    return {
      store,
      pool,
      auth,
      url,
      http,
      json,
      users,
      cookies,
      grant,
      tx,
      secret,
      transfer,
      opaque,
      split,
      pending,
      posted,
      budget,
      base,
      close
    };
  } catch (error) {
    await close();
    throw error;
  }
}
