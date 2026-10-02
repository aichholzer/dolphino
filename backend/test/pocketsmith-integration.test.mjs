import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  pocketSmithFixture,
  pocketAccount,
  pocketTransaction,
  testPocketSmithKey
} from './helpers/pocketsmith-fixture.mjs';
import { createPocketSmithIntegration } from '../src/lib/pocketsmith.mjs';
import { createManualLedger } from '../src/lib/manual-ledger.mjs';

const imported = async (f) => (await f.store.listTransactions()).filter((t) => t.accountId.startsWith('ps_'));
const lifecycle = async (f, id, action) => {
  const accounts = (await f.json('admin', action === 'restore' ? '/api/settings/deleted-accounts' : '/api/accounts'))
    .accounts;
  return f.json('admin', `/api/accounts/${id}/lifecycle`, 'POST', {
    requestId: randomUUID(),
    revision: accounts.find((a) => a.id === id).revision,
    action,
    reason: 'Synthetic PocketSmith lifecycle test'
  });
};

const sync = async (f) => {
  f.advance();
  await f.due();
  await f.pocketsmith.tick();
};

test('PocketSmith calendar boundaries and initial cursor do not shift with server or PostgreSQL timezone', async () => {
  const previousTimezone = process.env.TZ;
  process.env.TZ = 'Pacific/Auckland';
  let f;
  try {
    f = await pocketSmithFixture({ databaseTimezone: 'Pacific/Auckland' });
    await f.connect();
    await f.save({ backfillDays: 30 });
    await f.enable();
    const account = (await f.state()).accounts[0];
    assert.equal(account.backfillNext, '2026-09-02');
    assert.equal(account.backfillTo, '2026-10-03');
    const row = (await f.pool.query('SELECT cursor FROM pocketsmith_accounts')).rows[0];
    assert.equal(row.cursor.toISOString(), '2026-09-02T00:00:00.000Z');
    await f.finishBackfill();
    const windows = f.calls
      .map((call) => new URL(call.url))
      .filter((url) => url.pathname.endsWith('/transactions'))
      .map((url) => [url.searchParams.get('start_date'), url.searchParams.get('end_date')]);
    assert.deepEqual(windows, [
      ['2026-09-02', '2026-10-01'],
      ['2026-10-02', '2026-10-03']
    ]);
    assert.equal((await imported(f)).length, 1);
  } finally {
    await f?.close();
    if (previousTimezone === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = previousTimezone;
    }
  }
});

test('PocketSmith large JSON amounts remain exact in PostgreSQL and stale discovery preserves observed balances', async () => {
  const f = await pocketSmithFixture();
  try {
    await f.connect();
    await f.enable();
    const exact = '-90071992547409.93';
    f.setHook(async (url) => {
      if (url.pathname.endsWith('/transactions')) {
        const inRange =
          '2026-10-01' >= url.searchParams.get('start_date') && '2026-10-01' <= url.searchParams.get('end_date');
        const rows = inRange ? [pocketTransaction(101, { amount: exact })] : [];
        return {
          status: 200,
          headers: { total: String(rows.length), 'per-page': '500' },
          body: JSON.stringify(rows).replace(`"amount":"${exact}"`, `"amount":${exact}`)
        };
      }
    });
    await f.finishBackfill();
    assert.equal((await imported(f))[0].amountMinor, '-9007199254740993');
    const rawPages = (await f.pool.query('SELECT pages FROM pocketsmith_fetches ORDER BY id')).rows.flatMap(
      (row) => row.pages
    );
    assert.ok(rawPages.some((page) => page.body.includes(`"amount":${exact}`)));
    const id = (await f.state()).accounts[0].id;
    f.data.accounts[0].current_balance = 1;
    f.data.accounts[0].current_balance_date = '2026-09-01';
    const s = await f.state();
    await f.json('admin', '/api/settings/pocketsmith/test', 'POST', { revision: s.revision });
    await sync(f);
    const local = (await f.store.listAccounts()).find((a) => a.id === id);
    assert.equal(local.balanceMinor, '123456');
    assert.equal(local.coverage.balanceDate, '2026-10-02');
    const version = (await f.pool.query('SELECT cursor::text FROM pocketsmith_accounts')).rows[0].cursor;
    assert.ok(version.startsWith('2026-10-02 00:00:00.000001'), version);
    await assert.rejects(
      f.store.ingestBatch({ account: { id, currency: 'AUD', balanceMinor: '0' }, transactions: [] }),
      /dedicated import/
    );
  } finally {
    await f.close();
  }
});

test('PocketSmith migration is repeatable and preserves pre-existing accounts, evidence, corrections, budgets and grants', async () => {
  const f = await pocketSmithFixture();
  try {
    const snapshot = async () => {
      const result = {};
      for (const table of [
        'accounts',
        'transactions',
        'provider_observations',
        'transaction_overrides',
        'transaction_tags',
        'budgets',
        'user_account_grants'
      ]) {
        result[table] = (
          await f.pool.query(`SELECT jsonb_agg(r ORDER BY to_jsonb(r)::text) records FROM ${table} r`)
        ).rows[0].records;
      }

      return result;
    };

    const before = await snapshot();
    await f.pool.query(
      'DROP TABLE pocketsmith_accounts,pocketsmith_versions,pocketsmith_categories,pocketsmith_fetches,pocketsmith_state'
    );
    await f.store.migrate();
    await f.store.migrate();
    assert.deepEqual(await snapshot(), before);
    await f.connect();
    await f.enable();
    await f.finishBackfill();
    assert.equal((await imported(f)).length, 1);
  } finally {
    await f.close();
  }
});

test('PocketSmith encrypted settings use real HTTP authorization, origin, revisions and masked state', async () => {
  const f = await pocketSmithFixture();
  try {
    for (const user of ['anonymous', 'none', 'viewer', 'editor', 'budget']) {
      for (const [method, path] of [
        ['GET', ''],
        ['PUT', ''],
        ['POST', '/test'],
        ['POST', '/account'],
        ['POST', '/backfill']
      ]) {
        const response = await f.http(
          user,
          `/api/settings/pocketsmith${path}`,
          method,
          method === 'GET' ? undefined : {}
        );
        assert.equal(response.status, user === 'anonymous' ? 401 : 403);
      }
    }

    assert.equal(f.calls.length, 0);
    const initial = await f.state();
    assert.equal(
      (
        await f.http(
          'admin',
          '/api/settings/pocketsmith',
          'PUT',
          { revision: initial.revision, key: testPocketSmithKey, enabled: false, backfillDays: 90 },
          'https://evil.test'
        )
      ).status,
      403
    );
    await f.save({ key: testPocketSmithKey });
    const encrypted = (await f.pool.query("SELECT * FROM encrypted_credentials WHERE provider='pocketsmith'")).rows;
    assert.equal(encrypted.length, 1);
    assert.equal(encrypted[0].ciphertext.v, 3);
    assert.ok(!JSON.stringify(encrypted).includes(testPocketSmithKey));
    assert.ok(!JSON.stringify(await f.state()).includes(testPocketSmithKey));
    const before = await f.state();
    assert.equal(
      (
        await f.http('admin', '/api/settings/pocketsmith', 'PUT', {
          revision: initial.revision,
          enabled: false,
          backfillDays: 90
        })
      ).status,
      409
    );
    assert.equal(
      (
        await f.http('admin', '/api/settings/pocketsmith', 'PUT', {
          revision: before.revision,
          enabled: true,
          backfillDays: 90
        })
      ).status,
      409
    );
    f.setHook(async () => ({ status: 401, body: `Provider echo: ${testPocketSmithKey}` }));
    const denied = await f.http('admin', '/api/settings/pocketsmith/test', 'POST', { revision: before.revision });
    assert.equal(denied.status, 502);
    assert.deepEqual(await denied.json(), { error: 'pocketsmith_access_denied' });
    assert.equal((await f.state()).verified, false);
    f.setHook(null);
    await f.json('admin', '/api/settings/pocketsmith/test', 'POST', { revision: before.revision });
    await f.save({ key: '' });
    assert.equal((await f.state()).verified, true);
    assert.deepEqual(
      (await f.pool.query("SELECT ciphertext FROM encrypted_credentials WHERE provider='pocketsmith'")).rows[0]
        .ciphertext,
      encrypted[0].ciphertext
    );
    assert.ok(f.calls.every((call) => call.key === testPocketSmithKey));
    f.config.appSecret = 'unavailable';
    const unavailable = await f.state();
    assert.equal(unavailable.credentialsAvailable, false);
    assert.equal(unavailable.verified, false);
    const count = f.calls.length;
    await f.pocketsmith.tick();
    assert.equal(f.calls.length, count);
  } finally {
    await f.close();
  }
});

test('PocketSmith imports exact native data, pending states, source identity, labels and immutable evidence', async () => {
  const f = await pocketSmithFixture();
  try {
    f.data.accounts.push(pocketAccount(9002, { name: 'Second account', current_balance: -100 }));
    f.data.transactions.push(
      pocketTransaction(102, { status: 'pending', transaction_account: pocketAccount(9002), amount: -8.5 })
    );
    await f.connect();
    await f.enable();
    await f.finishBackfill();
    const accounts = (await f.store.listAccounts()).filter((a) => a.id.startsWith('ps_'));
    assert.equal(accounts.length, 2);
    assert.equal(
      accounts.reduce((n, a) => n + BigInt(a.balanceMinor), 0n),
      113456n
    );
    const rows = await imported(f);
    assert.equal(rows.length, 2);
    assert.equal(rows.find((t) => t.status === 'posted').amountMinor, '-1234');
    assert.equal(rows.find((t) => t.status === 'pending').amountMinor, '-850');
    assert.deepEqual(rows[0].tags, ['conference', 'work']);
    assert.ok(
      accounts.every((a) => a.sourceType === 'feed' && a.balanceAt === null && a.coverage.balanceDate === '2026-10-02')
    );
    const evidence = (await f.pool.query('SELECT * FROM pocketsmith_fetches ORDER BY id')).rows;
    assert.ok(evidence.length > 0);
    assert.equal(evidence.find((e) => e.account_evidence.id === '9001').account_evidence.current_balance, '1234.56');
    await assert.rejects(f.pool.query("UPDATE pocketsmith_fetches SET pages='[]'"), /immutable/);
    await assert.rejects(f.pool.query('DELETE FROM pocketsmith_fetches'), /immutable/);
    await assert.rejects(
      f.pool.query("UPDATE provider_observations SET payload='{}' WHERE provider LIKE 'pocketsmith:%'"),
      /immutable/
    );
    await assert.rejects(
      f.store.ingest({
        ...f.base,
        accountId: accounts[0].id,
        sourceId: 'foreign',
        provider: 'redbark',
        description: 'Other provider'
      }),
      /origin/
    );
    const calls = f.calls.length;
    await f.pocketsmith.tick();
    assert.equal(f.calls.length, calls);
    await sync(f);
    assert.equal((await imported(f)).length, 2);
    assert.ok(f.calls.some((call) => call.url.includes('updated_since=')));
  } finally {
    await f.close();
  }
});

test('PocketSmith corrections, label removals, category rename/archive, historical budgets and scoped reads persist', async () => {
  const f = await pocketSmithFixture();
  try {
    await f.connect();
    await f.enable();
    await f.finishBackfill();
    let tx = (await imported(f))[0];
    const originalCategory = tx.category;
    const budget = await f.store.saveBudget({
      category: originalCategory,
      currency: 'AUD',
      month: '2026-10',
      capMinor: '5000',
      allocationMinor: '0'
    });
    await f.grant('viewer', { accounts: [{ accountId: tx.accountId, access: 'view' }] });
    assert.ok((await f.json('viewer', '/api/transactions')).transactions.some((row) => row.id === tx.id));
    assert.ok(!(await f.json('none', '/api/transactions')).transactions.some((row) => row.id === tx.id));
    assert.ok(!(await f.json('none', '/api/categories')).catalog.some((row) => row.category === originalCategory));
    await f.store.correctTransaction(tx.id, { tags: ['local', 'work'], note: 'Keep my manual note' });
    f.data.transactions[0].category.title = 'Journeys';
    await sync(f);
    tx = (await imported(f))[0];
    assert.equal(tx.categoryDisplayLabel, 'Journeys');
    assert.deepEqual(tx.tags, ['local', 'work']);
    assert.equal(tx.note, 'Keep my manual note');
    let budgets = await f.store.listBudgets();
    assert.equal(budgets.find((b) => b.id === budget.id).categoryDisplayLabel, 'Journeys');
    await f.json('admin', '/api/settings/categories', 'PATCH', { category: originalCategory, name: 'My travel' });
    await f.json('admin', '/api/settings/categories', 'DELETE', { category: originalCategory });
    f.data.transactions[0].category.title = 'Another provider rename';
    await sync(f);
    tx = (await imported(f))[0];
    assert.equal(tx.categoryDisplayLabel, 'My travel');
    assert.equal(tx.amountMinor, '-1234');
    budgets = await f.store.listBudgets();
    assert.equal(budgets.find((b) => b.id === budget.id).category, originalCategory);
    assert.ok((await f.store.listCategoryCatalog()).find((c) => c.category === originalCategory).archived);
    await f.store.correctTransaction(tx.id, {
      category: 'Dining',
      kind: 'expense',
      splits: [{ category: 'Dining', amountMinor: '-1234' }]
    });
    f.data.transactions[0].category = null;
    f.data.transactions[0].updated_at = '2026-10-03T00:00:00Z';
    await sync(f);
    tx = (await imported(f))[0];
    assert.equal(tx.category, 'Dining');
    assert.equal(tx.splits[0].amountMinor, '-1234');
    const raw = (
      await f.pool.query(
        "SELECT payload FROM provider_observations WHERE provider LIKE 'pocketsmith:%' ORDER BY id LIMIT 1"
      )
    ).rows[0].payload;
    assert.equal(raw.raw.category.title, 'Travel');
    assert.equal(raw.raw.note, 'Provider note');
  } finally {
    await f.close();
  }
});

test('PocketSmith frozen/deleted imports continue, missing upstream retains history, purge prevents resurrection', async () => {
  const f = await pocketSmithFixture();
  try {
    await f.connect();
    await f.enable();
    await f.finishBackfill();
    const id = (await f.state()).accounts[0].id;
    await lifecycle(f, id, 'freeze');
    f.data.transactions.push(pocketTransaction(103, { payee: 'Imported while frozen' }));
    await sync(f);
    assert.equal((await imported(f)).length, 2);
    assert.equal((await f.store.listAccounts()).find((a) => a.id === id).includedInBalance, false);
    await lifecycle(f, id, 'delete');
    f.data.transactions.push(pocketTransaction(104, { payee: 'Imported while hidden' }));
    await sync(f);
    assert.equal((await imported(f)).length, 0);
    assert.equal(
      (await f.pool.query('SELECT count(*) FROM transactions WHERE account_id=$1', [id])).rows[0].count,
      '3'
    );
    const freshness = (
      await f.pool.query("SELECT fetched_at FROM accounts WHERE mode='live' AND id=$1", [id])
    ).rows[0].fetched_at.toISOString();
    f.data.accounts = [];
    await sync(f);
    assert.equal((await f.state()).accounts[0].lastError, 'pocketsmith_source_missing');
    assert.equal(
      (
        await f.pool.query("SELECT fetched_at FROM accounts WHERE mode='live' AND id=$1", [id])
      ).rows[0].fetched_at.toISOString(),
      freshness
    );
    await lifecycle(f, id, 'restore');
    assert.equal((await imported(f)).length, 3);
    await lifecycle(f, id, 'delete');
    const preview = await f.json('admin', '/api/settings/deleted-accounts/preview', 'POST', { accountIds: [id] });
    assert.ok(preview.counts.pocketsmith_fetches > 0);
    await f.json('admin', '/api/settings/deleted-accounts/purge', 'POST', {
      accountIds: [id],
      previewToken: preview.previewToken,
      confirmation: preview.confirmation,
      requestId: randomUUID()
    });
    assert.equal(
      (await f.pool.query('SELECT count(*) FROM pocketsmith_fetches WHERE account_id=$1', [id])).rows[0].count,
      '0'
    );
    assert.equal(
      (await f.pool.query('SELECT count(*) FROM pocketsmith_versions WHERE account_id=$1', [id])).rows[0].count,
      '0'
    );
    f.data.accounts = [pocketAccount()];
    const s = await f.state();
    await f.json('admin', '/api/settings/pocketsmith/test', 'POST', { revision: s.revision });
    assert.equal((await f.state()).accounts.length, 0);
    await sync(f);
    assert.equal((await f.pool.query('SELECT count(*) FROM accounts WHERE id=$1', [id])).rows[0].count, '0');
    await assert.rejects(
      f.pool.query('DELETE FROM provider_observations WHERE transaction_id=$1', [f.tx.id]),
      /immutable/
    );
  } finally {
    await f.close();
  }
});

test('PocketSmith partial pages, source version conflicts and staleness never corrupt totals or advance cursor', async () => {
  const f = await pocketSmithFixture();
  try {
    await f.connect();
    await f.enable();
    await f.finishBackfill();
    const initial = (await imported(f))[0];
    const cursor = () => f.pool.query('SELECT cursor::text FROM pocketsmith_accounts');
    const before = (await cursor()).rows[0].cursor;
    f.data.transactions = Array.from({ length: 501 }, (_, i) => pocketTransaction(1000 + i));
    f.setHook(async (url) =>
      url.searchParams.get('page') === '2' ? { status: 503, body: `secret ${testPocketSmithKey}` } : null
    );
    await sync(f);
    assert.equal((await imported(f)).length, 1);
    assert.equal((await cursor()).rows[0].cursor, before);
    f.setHook(null);
    f.data.transactions = [pocketTransaction(101, { amount: -99 })];
    await sync(f);
    assert.equal((await imported(f))[0].amountMinor, initial.amountMinor);
    assert.equal((await f.state()).accounts[0].lastError, 'pocketsmith_conflicting_source_version');
    f.data.transactions = [pocketTransaction(101, { amount: -99, updated_at: '2026-10-01T23:59:59.999999Z' })];
    await sync(f);
    assert.equal((await imported(f))[0].amountMinor, initial.amountMinor);
    f.data.transactions = [];
    await sync(f);
    assert.equal((await imported(f)).length, 1);
    assert.ok(!JSON.stringify(await f.state()).includes(testPocketSmithKey));
  } finally {
    await f.close();
  }
});

test('PocketSmith in-flight key/selection changes and current admin revocation fence writes', async () => {
  const f = await pocketSmithFixture();
  try {
    await f.connect();
    await f.enable();
    let release, entered;
    const waiting = new Promise((resolve) => {
      entered = resolve;
    });
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    f.setHook(async (url) => {
      if (url.pathname.endsWith('/transactions')) {
        entered();
        await gate;
      }
    });
    const work = f.pocketsmith.tick();
    await waiting;
    await f.save({ key: 'synthetic-replacement-key-not-live', enabled: false });
    release();
    await work;
    assert.equal((await imported(f)).length, 0);
    assert.equal((await f.pool.query('SELECT count(*) FROM pocketsmith_fetches')).rows[0].count, '0');
    f.setHook(null);
    let done, start;
    const started = new Promise((resolve) => {
      start = resolve;
    });
    const blocked = new Promise((resolve) => {
      done = resolve;
    });
    f.setHook(async (url) => {
      if (url.pathname === '/v2/me') {
        start();
        await blocked;
      }
    });
    const state = await f.state();
    const discovery = f.http('admin', '/api/settings/pocketsmith/test', 'POST', { revision: state.revision });
    await started;
    await f.pool.query("UPDATE household_users SET role='member' WHERE id=$1", [f.users.admin.id]);
    done();
    assert.equal((await discovery).status, 403);
    const stored = (await f.pool.query("SELECT value FROM app_settings WHERE key='pocketsmith'")).rows[0].value;
    assert.equal(stored.userId, null);
  } finally {
    await f.close();
  }
});

test('PocketSmith worker locks prevent duplicate polls and Retry-After pauses the entire connection', async () => {
  const f = await pocketSmithFixture();
  try {
    await f.connect();
    await f.enable();
    let entered, release;
    const started = new Promise((r) => {
      entered = r;
    });
    const gate = new Promise((r) => {
      release = r;
    });
    f.setHook(async () => {
      entered();
      await gate;
      return { status: 429, headers: { 'retry-after': '864000' }, body: testPocketSmithKey };
    });
    const work = f.pocketsmith.tick();
    await started;
    const other = createPocketSmithIntegration({
      pool: f.pool,
      store: f.store,
      settings: f.settings,
      config: f.config,
      request: () => {
        throw Error('Parallel worker must not dial');
      }
    });
    await other.tick();
    release();
    await work;
    const calls = f.calls.length;
    f.advance(5 * 3600000);
    await f.due();
    await f.pocketsmith.tick();
    assert.equal(f.calls.length, calls);
    const state = await f.state();
    assert.equal(state.lastError, 'pocketsmith_rate_limited');
    assert.equal(
      (await f.http('admin', '/api/settings/pocketsmith/test', 'POST', { revision: state.revision })).status,
      409
    );
    assert.equal(f.calls.length, calls);
    assert.equal((await imported(f)).length, 0);
    assert.ok(!JSON.stringify(state).includes(testPocketSmithKey));
  } finally {
    await f.close();
  }
});

test('PocketSmith cannot convert manual accounts and malformed source responses fail atomically', async () => {
  const f = await pocketSmithFixture();
  try {
    const ledger = createManualLedger(f.store, f.users.admin);
    const manual = await ledger.createAccount({
      requestId: randomUUID(),
      name: 'Manual wallet',
      currency: 'AUD',
      openingDate: '2026-09-01',
      openingBalanceMinor: '1000'
    });
    await f.connect();
    await f.enable();
    const state = await f.state();
    assert.equal(
      (
        await f.http('admin', '/api/settings/pocketsmith/account', 'POST', {
          revision: state.revision,
          accountId: manual.account.id,
          enabled: true
        })
      ).status,
      400
    );
    f.data.transactions[0].transaction_account.currency_code = 'USD';
    await f.pocketsmith.tick();
    // The first backfill window may be empty; finish only up to the corrupt window.
    for (let i = 0; i < 5; i++) {
      await f.due();
      await f.pocketsmith.tick();
    }

    assert.equal((await imported(f)).length, 0);
    assert.equal((await f.store.listAccounts()).find((a) => a.id === manual.account.id).balanceMinor, '1000');
    assert.equal((await f.state()).accounts[0].lastError, 'pocketsmith_invalid_transaction');
  } finally {
    await f.close();
  }
});
