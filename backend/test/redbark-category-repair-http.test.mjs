import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { readTestPostgresConfig } from './helpers/postgres.mjs';
import { Store } from '../src/lib/store.mjs';
import { createApp } from '../src/app.mjs';
import { createHouseholdAuth } from '../src/lib/household-auth.mjs';
import { createSettingsStore } from '../src/lib/settings.mjs';
import {
  createRedbarkSettings,
  REDBARK_SETTINGS_LOCK,
  redbarkAccountFingerprint
} from '../src/lib/redbark-settings.mjs';
import { createRedbarkIntegration } from '../src/lib/worker.mjs';
import { createImportHealth } from '../src/lib/import-health.mjs';
import { normalizeTransaction } from '../src/lib/redbark.mjs';

// Real PostgreSQL, TCP HTTP, sessions, settings and domain code. Only outbound
// provider transport is mocked, with synthetic credentials and source evidence.
const database = readTestPostgresConfig();
const options = { skip: !database, timeout: 20000 };
const repairPath = '/api/import-health/repair-categories';
const account = (id) => ({ id, name: `Synthetic ${id}`, currency: 'aud', category: 'banking' });
const taxonomy = [
  { id: 'cat_Food', name: 'Groceries' },
  { id: 'cat_Transfer', name: 'Moving money' }
];
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

async function fixture(t, { mode = 'live', configured = true } = {}) {
  const admin = new pg.Pool(database);
  const schema = `repair_http_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ ...database, options: `-c search_path=${schema}` });
  const config = {
    mode,
    host: '127.0.0.1',
    port: 0,
    origin: 'https://dolphino.test',
    timezone: 'Etc/UTC',
    currency: 'AUD',
    appSecret: randomBytes(32).toString('base64')
  };
  const store = new Store(pool, { mode });
  await store.migrate();
  const settings = createSettingsStore({ pool, appSecret: config.appSecret, envConfig: config });
  await settings.init();
  const redbark = createRedbarkSettings({ pool, settings, appSecret: config.appSecret });
  if (configured) {
    await redbark.save({ apiKey: 'synthetic-repair-key' });
  }

  const outbound = [];
  const remote = { accounts: [account('acct_A')], categories: taxonomy, categoryStatus: 200, balanceStatus: 200 };
  let hook;
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input);
    outbound.push({ path: url.pathname, search: url.search, headers: structuredClone(init.headers) });
    assert.equal(url.origin, 'https://api.redbark.com');
    assert.match(init.headers.Authorization, /^Bearer synthetic-/);
    if (hook) {
      const response = await hook(url, init);
      if (response) {
        return response;
      }
    }

    if (url.pathname.endsWith('/accounts')) {
      return Response.json({ data: remote.accounts, next_page_url: null });
    }

    if (url.pathname.endsWith('/categories')) {
      return remote.categoryStatus === 200
        ? Response.json({ data: remote.categories, next_page_url: null })
        : Response.json(
            { error: 'Private upstream diagnostic must never be exposed' },
            {
              status: remote.categoryStatus,
              headers: { 'Retry-After': '600' }
            }
          );
    }

    if (url.pathname.endsWith('/balance')) {
      return remote.balanceStatus === 200
        ? Response.json({ current: { amount: 10000, currency: 'aud' } })
        : Response.json({}, { status: remote.balanceStatus, headers: { 'Retry-After': '600' } });
    }

    if (url.pathname.endsWith('/transactions')) {
      return Response.json({ data: [], next_page_url: null });
    }

    assert.fail(`Unexpected provider request ${url.pathname}`);
  };

  const makeIntegration = () =>
    createRedbarkIntegration({
      pool,
      store,
      config,
      getRedbarkConfig: redbark.getRuntimeConfig,
      fetchImpl
    });
  const integration = makeIntegration();
  await integration.init();
  const importHealth = createImportHealth({ pool, store, config, integration });
  const auth = createHouseholdAuth({ pool, config });
  await auth.init();
  const cookies = {};
  for (const role of ['admin', 'member']) {
    const user = (
      await pool.query(
        "INSERT INTO household_users(email,name,role,password_hash) VALUES($1,$2,$2,'unused-synthetic-hash') RETURNING id",
        [`${role}@example.test`, role]
      )
    ).rows[0];
    const token = randomBytes(32).toString('base64url');
    await pool.query(
      "INSERT INTO household_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",
      [createHash('sha256').update(token).digest('hex'), user.id]
    );
    cookies[role] = `dolphino_session=${token}`;
  }

  const app = createApp({ store, config, settings, redbarkSettings: redbark, auth, integration, importHealth });
  const server = await new Promise((resolve) => {
    const instance = app.start(() => resolve(instance));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await integration.stop();
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });
  async function request({ who = 'admin', origin = config.origin, body = '{}', method = 'POST' } = {}) {
    const response = await fetch(base + repairPath, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(cookies[who] ? { Cookie: cookies[who] } : {}),
        ...(origin === null ? {} : { Origin: origin })
      },
      ...(method === 'GET' ? {} : { body })
    });
    const text = await response.text();
    return { status: response.status, headers: response.headers, text, json: JSON.parse(text) };
  }

  async function verify() {
    await integration.testConnection();
    outbound.length = 0;
  }

  async function legacy(id, patch = {}, provider = 'redbark') {
    const raw = {
      id: `txn_${id}`,
      account: 'acct_A',
      amount: { amount: -1234, currency: 'aud' },
      date: '2021-03-01',
      description: `Synthetic merchant ${id}`,
      status: 'posted',
      provider_category: 'FOOD_AND_DRINK',
      category: 'cat_Food',
      ...patch
    };
    const observed = normalizeTransaction(raw, raw.account, '2021-03-02T00:00:00Z');
    const transaction = await store.ingest({ ...observed, mode, provider });
    // Recreate persisted legacy derived values without relying on today's ingest
    // implementation still accepting an opaque reference as a display category.
    await pool.query('UPDATE transactions SET provider_category=$2,classification_category=$2 WHERE id=$1', [
      transaction.id,
      raw.category
    ]);
    return transaction.id;
  }

  async function invariants() {
    const queries = {
      financial:
        "SELECT to_jsonb(t)-'provider_category'-'classification_category'-'review_reason' value FROM transactions t ORDER BY id",
      accounts: 'SELECT * FROM accounts ORDER BY mode,id',
      evidence: 'SELECT * FROM provider_observations ORDER BY id',
      aliases: 'SELECT * FROM source_aliases ORDER BY mode,provider,account_id,source_id',
      fetches: 'SELECT * FROM redbark_fetches ORDER BY id',
      receipts: 'SELECT * FROM redbark_receipts ORDER BY event_id',
      overrides: 'SELECT * FROM transaction_overrides ORDER BY transaction_id',
      jobs: 'SELECT * FROM redbark_jobs ORDER BY id',
      budgets: 'SELECT * FROM budgets ORDER BY id',
      rules: 'SELECT * FROM rules ORDER BY id'
    };
    const result = {};
    for (const [name, query] of Object.entries(queries)) {
      result[name] = (await pool.query(query)).rows;
    }

    return result;
  }

  return {
    pool,
    store,
    settings,
    redbark,
    config,
    integration,
    importHealth,
    makeIntegration,
    remote,
    outbound,
    request,
    verify,
    legacy,
    invariants,
    setHook: (value) => {
      hook = value;
    }
  };
}

function categoryOnly(outbound) {
  assert.deepEqual(
    outbound.map((entry) => entry.path),
    ['/v2/accounts', '/v2/categories']
  );
}

function resultShape(value) {
  for (const name of [
    'accounts',
    'updated',
    'unresolved',
    'manualReferencesUpdated',
    'manualReferencesPreserved',
    'examined',
    'skipped',
    'budgetsNeedingReview',
    'rulesNeedingReview'
  ]) {
    assert(Number.isInteger(value[name]) && value[name] >= 0, `${name} must be a nonnegative count`);
  }

  assert.equal(typeof value.message, 'string');
  assert(value.message.length > 0);
}

test('category repair HTTP is admin-only, exact-Origin guarded and strict about empty JSON', options, async (t) => {
  const f = await fixture(t);
  await f.legacy('Boundary');
  await f.verify();
  for (const [request, status] of [
    [{ who: 'anonymous' }, 401],
    [{ who: 'member' }, 403],
    [{ origin: null }, 403],
    [{ origin: 'https://evil.example' }, 403],
    [{ origin: 'https://dolphino.test.evil.example' }, 403],
    [{ body: '{invalid' }, 400],
    [{ body: 'null' }, 400],
    [{ body: '[]' }, 400],
    [{ body: '{"accountId":"acct_A","force":true}' }, 400]
  ]) {
    assert.equal((await f.request(request)).status, status);
  }

  assert.equal(f.outbound.length, 0, 'invalid requests must not reach provider I/O');
  const response = await f.request();
  assert.equal(response.status, 200, response.text);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  resultShape(response.json);
  categoryOnly(f.outbound);
});

test(
  'explicit repair fixes all historical derived categories after a completed poll without fetching banking data or changing evidence',
  options,
  async (t) => {
    const f = await fixture(t);
    const plain = await f.legacy('Plain');
    const savedReference = await f.legacy('SavedReference');
    const custom = await f.legacy('CustomCategory');
    const manual = await f.legacy('ManualChoice');
    const ruled = await f.legacy('Ruled');
    const ai = await f.legacy('AcceptedAI', { category: 'cat_Missing' });
    const transfer = await f.legacy('Transfer', { provider_category: 'TRANSFER_OUT', category: 'cat_Transfer' });
    const pending = await f.legacy('Pending', { status: 'pending' });
    const refund = await f.legacy('Refund', { amount: { amount: 1234, currency: 'aud' } });
    const income = await f.legacy('Income', { amount: { amount: 5000, currency: 'aud' }, provider_category: 'INCOME' });
    const inaccessible = await f.legacy('Inaccessible', { account: 'acct_B' });
    const simplefin = await f.legacy('SimplefinOwned', { account: 'acct_SF' });
    const foreign = await f.legacy('OtherSource', {}, 'other-provider');
    const untouched = [inaccessible, simplefin, foreign];
    await f.pool.query(
      "INSERT INTO simplefin_accounts(source_id,remote_key,identity_key,metadata,local_id) VALUES($1,'synthetic-remote','synthetic-identity','{}','acct_SF')",
      [randomUUID()]
    );
    f.remote.accounts.push(account('acct_SF'), account('acct_Unimported'));
    for (const [id, category] of [
      [savedReference, 'cat_Food'],
      [custom, 'cat_custom'],
      [manual, 'My food']
    ]) {
      await f.pool.query(
        'INSERT INTO transaction_overrides(transaction_id,category,kind,splits,note) VALUES($1,$2,$3,$4,$5)',
        [
          id,
          category,
          'expense',
          JSON.stringify([{ category: id === manual ? 'cat_Food' : 'My food', amountMinor: '-1234' }]),
          'Preserve my explicit note'
        ]
      );
    }

    await f.store.saveRule({ contains: 'merchant ruled', category: 'Rule food', kind: 'expense' });
    for (const category of ['cat_Food', 'cat_custom']) {
      await f.pool.query(
        "INSERT INTO budgets(id,mode,category,currency,month,cap_minor) VALUES($1,'live',$2,'AUD','2021-03',100)",
        [randomUUID(), category]
      );
      await f.pool.query("INSERT INTO rules(id,mode,contains,category,kind) VALUES($1,'live',$2,$3,'expense')", [
        randomUUID(),
        `unmatched legacy rule ${category}`,
        category
      ]);
    }

    await f.pool.query("UPDATE transactions SET ai_category='Shopping' WHERE id=$1", [ai]);
    await f.store.updateAccount(
      {
        id: 'acct_A',
        name: 'Synthetic balance',
        currency: 'AUD',
        balanceMinor: '987654321',
        balanceType: 'current',
        balanceAt: '2021-03-02T00:00:00Z',
        fetchedAt: '2021-03-02T00:00:00Z'
      },
      { from: '2021-01-01', to: '2021-03-02', truncated: false }
    );
    await f.pool.query("INSERT INTO redbark_fetches(account_id,fetched_at,raw) VALUES('acct_A',now(),$1)", [
      { account: account('acct_A'), balance: { current: { amount: 987654321, currency: 'aud' } }, transactions: [] }
    ]);
    await f.pool.query('INSERT INTO redbark_receipts(event_id,body,body_hash) VALUES($1,$2,$3)', [
      'evt_SyntheticHistorical',
      Buffer.from('{"synthetic":true}'),
      'synthetic-body-hash'
    ]);
    await f.verify();
    const current = await f.redbark.getRuntimeConfig();
    const fingerprint = redbarkAccountFingerprint(current.redbarkApiKey);
    await f.pool.query(
      "INSERT INTO redbark_jobs(dedupe_key,account_fingerprint,status,completed_at) VALUES($1,$2,'completed',now())",
      [`poll:${fingerprint}:${Math.floor(Date.now() / (4 * 3600000))}`, fingerprint]
    );
    await f.integration.tick();
    assert.equal(f.outbound.length, 0, 'the completed four-hour poll bucket prevents ordinary sync');
    const before = await f.invariants();
    const reportBefore = await f.store.report({ month: '2021-03', currency: 'AUD' });
    const response = await f.request();
    assert.equal(response.status, 200, response.text);
    resultShape(response.json);
    assert.equal(response.json.accounts, 1);
    assert(response.json.updated > 0);
    assert(response.json.examined >= 10);
    assert(
      response.json.unresolved >= 3,
      'unresolved taxonomy and deliberately preserved manual references are visible'
    );
    assert.equal(response.json.manualReferencesUpdated, 0);
    assert.equal(response.json.manualReferencesPreserved, 2);
    assert.equal(response.json.budgetsNeedingReview, 1);
    assert.equal(response.json.rulesNeedingReview, 1);
    assert.equal(response.json.skipped, 2);
    categoryOnly(f.outbound);
    assert.deepEqual(
      await f.invariants(),
      before,
      'repair changes no financial fields, balances, evidence, overrides or jobs'
    );
    for (const id of [plain, pending, refund, income]) {
      assert.equal((await f.store.getTransaction(id)).category, 'Groceries');
    }

    assert.equal((await f.store.getTransaction(savedReference)).category, 'cat_Food');
    assert.equal((await f.store.getTransaction(custom)).category, 'cat_custom');
    assert.equal((await f.store.getTransaction(manual)).category, 'My food');
    assert.equal((await f.store.getTransaction(manual)).splits[0].category, 'cat_Food');
    assert.equal((await f.store.getTransaction(ruled)).category, 'Rule food');
    assert.equal((await f.store.getTransaction(ai)).category, 'Shopping');
    assert.equal((await f.store.getTransaction(transfer)).kind, 'transfer');
    assert.match((await f.store.getTransaction(transfer)).reviewReason, /transfer/i);
    for (const id of untouched) {
      assert.equal((await f.store.getTransaction(id)).category, 'cat_Food');
    }

    assert.equal((await f.pool.query("SELECT 1 FROM accounts WHERE id='acct_Unimported'")).rowCount, 0);
    const reportAfter = await f.store.report({ month: '2021-03', currency: 'AUD' });
    for (const key of ['incomeMinor', 'expensesMinor', 'netMinor', 'pendingMinor', 'transfersMinor']) {
      assert.equal(reportAfter[key], reportBefore[key], key);
    }

    const audit = (await f.pool.query('SELECT * FROM audit_history ORDER BY id')).rows;
    assert(audit.some((row) => row.action === 'redbark-category-resolved'));
    const alerts = (await f.pool.query('SELECT * FROM budget_alerts ORDER BY id')).rows;
    f.outbound.length = 0;
    const repeated = await f.request();
    assert.equal(repeated.status, 200, repeated.text);
    assert.equal(repeated.json.updated, 0);
    assert.equal(repeated.json.manualReferencesUpdated, 0);
    assert.equal(repeated.json.manualReferencesPreserved, 2);
    assert.equal(repeated.json.budgetsNeedingReview, 1);
    assert.equal(repeated.json.rulesNeedingReview, 1);
    assert.deepEqual((await f.pool.query('SELECT * FROM budget_alerts ORDER BY id')).rows, alerts);
    assert.deepEqual((await f.pool.query('SELECT * FROM audit_history ORDER BY id')).rows, audit);
    assert.deepEqual(await f.invariants(), before);
    categoryOnly(f.outbound);
  }
);

for (const scenario of [
  { name: 'unverified', mode: 'live', configured: true },
  { name: 'unconfigured', mode: 'live', configured: false },
  { name: 'demo', mode: 'demo', configured: true }
]) {
  test(`category repair refuses ${scenario.name} configuration without any provider call`, options, async (t) => {
    const f = await fixture(t, scenario);
    const before = await f.invariants();
    const response = await f.request();
    assert.equal(response.status, 409, response.text);
    assert.equal(f.outbound.length, 0);
    assert.deepEqual(await f.invariants(), before);
  });
}

test(
  'missing category permission is visible without fetching balances, history or exposing provider diagnostics',
  options,
  async (t) => {
    const f = await fixture(t);
    const old = await f.legacy('Forbidden');
    await f.verify();
    f.remote.categoryStatus = 403;
    const before = await f.invariants();
    const response = await f.request();
    assert.equal(response.status, 403, response.text);
    assert.doesNotMatch(response.text, /Private upstream diagnostic/);
    categoryOnly(f.outbound);
    assert.deepEqual(await f.invariants(), before);
    assert.equal((await f.integration.status()).categoryWarning, 'category_lookup_forbidden');
    if (response.status === 200) {
      resultShape(response.json);
      assert(response.json.skipped || response.json.unresolved > 0);
    }

    // A later permission grant can repair the same historical row immediately.
    f.remote.categoryStatus = 200;
    f.outbound.length = 0;
    const retry = await f.request();
    assert.equal(retry.status, 200, retry.text);
    assert.equal((await f.store.getTransaction(old)).category, 'Groceries');
    categoryOnly(f.outbound);
  }
);

for (const status of [429, 503]) {
  test(
    `category provider ${status} establishes global Retry-After respected by repair and worker`,
    options,
    async (t) => {
      const f = await fixture(t);
      await f.legacy(`Limited${status}`);
      await f.verify();
      f.remote.categoryStatus = status;
      const before = await f.invariants();
      const response = await f.request();
      assert.equal(response.status, status === 429 ? 429 : 502, response.text);
      categoryOnly(f.outbound);
      assert.deepEqual(await f.invariants(), before);
      const state = (await f.pool.query('SELECT * FROM redbark_state WHERE id=1')).rows[0];
      assert.equal(state.last_error, `provider_http_${status}`);
      assert(new Date(state.next_attempt).getTime() > Date.now() + 590000);
      const count = f.outbound.length;
      const retry = await f.request();
      assert.equal(retry.status, 429, retry.text);
      await f.integration.tick();
      assert.equal(f.outbound.length, count, 'neither manual repair nor worker may bypass global backoff');
      assert.deepEqual(await f.invariants(), before);
    }
  );
}

test('existing global backoff prevents even account discovery during manual category repair', options, async (t) => {
  const f = await fixture(t);
  await f.legacy('Backoff');
  await f.verify();
  await f.pool.query("UPDATE redbark_state SET next_attempt=now()+interval '10 minutes' WHERE id=1");
  const before = await f.invariants();
  const response = await f.request();
  assert.equal(response.status, 429, response.text);
  assert.equal(f.outbound.length, 0);
  assert.deepEqual(await f.invariants(), before);
});

test('credential revision drift during category fetch aborts every repair before commit', options, async (t) => {
  const f = await fixture(t);
  const old = await f.legacy('Drift');
  await f.verify();
  const before = await f.invariants();
  f.setHook(async (url) => {
    if (url.pathname.endsWith('/categories')) {
      // Simulate an out-of-band configuration revision, bypassing the normal
      // settings lock. A final revision check must still protect the commit.
      const { value } = await f.redbark.snapshot();
      await f.settings.setValue('redbark', { ...value, revision: randomUUID() });
    }
  });
  const response = await f.request();
  assert.equal(response.status, 409, response.text);
  assert.equal((await f.store.getTransaction(old)).category, 'cat_Food');
  assert.deepEqual(await f.invariants(), before);
  assert.equal((await f.integration.status()).verified, false);
  assert.equal(
    (await f.pool.query("SELECT 1 FROM audit_history WHERE action='redbark-category-resolved'")).rowCount,
    0
  );
});

test('manual category repair holds worker and settings locks across provider reads', options, async (t) => {
  const f = await fixture(t);
  await f.legacy('Serialized');
  await f.verify();
  const entered = deferred();
  const release = deferred();
  f.setHook(async (url) => {
    if (url.pathname.endsWith('/categories')) {
      entered.resolve();
      await release.promise;
    }
  });
  const pending = f.request();
  await entered.promise;
  const db = await f.pool.connect();
  let workerLock = false,
    settingsLock = false;
  try {
    workerLock = (await db.query('SELECT pg_try_advisory_lock(73426712,hashtext(current_schema())) acquired')).rows[0]
      .acquired;
    settingsLock = (await db.query('SELECT pg_try_advisory_lock($1) acquired', [REDBARK_SETTINGS_LOCK])).rows[0]
      .acquired;
    assert.equal(workerLock, false, 'repair must share the ordinary worker session lock');
    assert.equal(settingsLock, false, 'repair must share the credential settings lock');
    assert.equal((await f.request()).status, 409, 'same-process concurrent repair is rejected');
    const other = f.makeIntegration();
    await assert.rejects(other.repairCategories(), { status: 409 });
    await other.tick();
    assert.equal(f.outbound.length, 2, 'another worker cannot enter provider I/O during repair');
  } finally {
    if (workerLock) {
      await db.query('SELECT pg_advisory_unlock(73426712,hashtext(current_schema()))');
    }

    if (settingsLock) {
      await db.query('SELECT pg_advisory_unlock($1)', [REDBARK_SETTINGS_LOCK]);
    }

    db.release();
    release.resolve();
  }

  const response = await pending;
  assert.equal(response.status, 200, response.text);
  categoryOnly(f.outbound);
});

test('normal worker repairs historical categories before a subsequent balance failure', options, async (t) => {
  const f = await fixture(t);
  const old = await f.legacy('BeforeBalance');
  await f.verify();
  f.remote.balanceStatus = 429;
  await f.integration.tick();
  assert.equal((await f.store.getTransaction(old)).category, 'Groceries');
  assert.deepEqual(
    f.outbound.map((entry) => entry.path),
    ['/v2/accounts', '/v2/categories', '/v2/accounts/acct_A/balance']
  );
  assert.equal((await f.integration.status()).lastError, 'provider_http_429');
  assert.equal((await f.pool.query('SELECT * FROM redbark_fetches')).rowCount, 0);
});

test('malformed category taxonomy aborts without partial category changes or bank reads', options, async (t) => {
  const f = await fixture(t);
  const old = await f.legacy('Malformed');
  await f.verify();
  f.remote.categories = [taxonomy[0], { id: 'cat_Invalid', name: '' }];
  const before = await f.invariants();
  const response = await f.request();
  assert.equal(response.status, 502, response.text);
  assert.equal((await f.store.getTransaction(old)).category, 'cat_Food');
  assert.deepEqual(await f.invariants(), before);
  categoryOnly(f.outbound);
  assert.equal((await f.integration.status()).categoryWarning, 'category_lookup_unavailable');
});

test('all eligible accounts roll back together when a category write fails', options, async (t) => {
  const f = await fixture(t);
  const first = await f.legacy('AtomicA');
  const second = await f.legacy('AtomicB', { account: 'acct_B' });
  f.remote.accounts.push(account('acct_B'));
  await f.verify();
  await f.pool.query(`
    CREATE FUNCTION reject_synthetic_category_write() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.account_id='acct_B' THEN RAISE EXCEPTION 'Synthetic private failure'; END IF;
      RETURN NEW;
    END; $$;
    CREATE TRIGGER synthetic_category_write_failure BEFORE UPDATE ON transactions
    FOR EACH ROW EXECUTE FUNCTION reject_synthetic_category_write();
  `);
  const before = await f.invariants();
  const response = await f.request();
  assert.equal(response.status, 500, response.text);
  assert.doesNotMatch(response.text, /Synthetic private failure/);
  for (const id of [first, second]) {
    assert.equal((await f.store.getTransaction(id)).category, 'cat_Food');
  }

  assert.deepEqual(await f.invariants(), before);
  assert.equal(
    (await f.pool.query("SELECT 1 FROM audit_history WHERE action='redbark-category-resolved'")).rowCount,
    0
  );
  categoryOnly(f.outbound);
  await f.pool.query('DROP TRIGGER synthetic_category_write_failure ON transactions');
  f.outbound.length = 0;
  const repeated = await f.request();
  assert.equal(repeated.status, 200, repeated.text);
  assert.equal(repeated.json.accounts, 2);
  assert.equal(repeated.json.updated, 2);
  categoryOnly(f.outbound);
});
