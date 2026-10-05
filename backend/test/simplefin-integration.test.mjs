import { readTestPostgresConfig } from './helpers/postgres.mjs';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomBytes, randomUUID } from 'node:crypto';
import { Store } from '../src/lib/store.mjs';
import { createSettingsStore } from '../src/lib/settings.mjs';
import { createSimplefinIntegration } from '../src/lib/simplefin.mjs';
import { createRedbarkIntegration } from '../src/lib/worker.mjs';
import { createApp } from '../src/app.mjs';
const database = readTestPostgresConfig();
async function fixture(t, host = 'provider.example.com') {
  const admin = new pg.Pool(database),
    schema = `simplefin_${randomUUID().replaceAll('-', '')}`;
  admin.on('error', () => {});
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({
    ...database,
    options: `-c search_path=${schema}`
  });
  pool.on('error', () => {});
  const config = {
    mode: 'live',
    appSecret: randomBytes(32).toString('base64'),
    timezone: 'Etc/UTC',
    origin: 'https://dolphino.test',
    host: '127.0.0.1',
    port: 0
  };
  const store = new Store(pool, { mode: 'live', timezone: config.timezone });
  await store.migrate();
  const settings = createSettingsStore({ pool, appSecret: config.appSecret });
  await settings.init();
  let clock = Date.now();
  const epoch = Math.floor(clock / 1000) - 3600;
  const data = {
    errors: [],
    accounts: [
      {
        id: 'account-one',
        name: 'Fictional bank',
        org: { domain: 'bank.example.com' },
        currency: 'AUD',
        balance: '120.10',
        'balance-date': epoch,
        transactions: [
          {
            id: 'tx-one',
            posted: epoch,
            amount: '-12.34',
            description: 'Fictional grocer'
          }
        ]
      }
    ]
  };
  const access = `https://synthetic-user:synthetic-password@${host}/simplefin`;
  const calls = [];
  let hook;
  const request = async (url, options) => {
    calls.push({ url: String(url), method: options?.method || 'GET' });
    if (hook) {
      const value = await hook(url, options);
      if (value) {
        return value;
      }
    }

    if (options?.method === 'POST') {
      return { status: 200, body: access };
    }

    const response = structuredClone(data);
    if (url.searchParams.has('balances-only')) {
      for (const a of response.accounts) {
        a.transactions = [];
      }
    } else {
      for (const a of response.accounts) {
        a.transactions = a.transactions.filter(
          (x) =>
            x.pending ||
            (x.posted >= Number(url.searchParams.get('start-date')) &&
              x.posted < Number(url.searchParams.get('end-date')))
        );
      }
    }

    return { status: 200, body: JSON.stringify(response) };
  };

  const make = (options = {}) =>
    createSimplefinIntegration({
      pool,
      store,
      settings,
      config,
      request,
      now: () => clock,
      ...options
    });
  const sf = make();
  await sf.init();
  const token = (id = randomUUID()) => Buffer.from(`https://${host}/simplefin/claim/${id}`).toString('base64');
  const connect = async () => {
    await sf.connect({ token: token() });
    await sf.discover();
    return (await sf.status()).accounts[0];
  };

  const enable = async () => sf.save({ enabled: true, backfillDays: 30 });
  t.after(async () => {
    await sf.stop();
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });
  return {
    pool,
    config,
    store,
    settings,
    sf,
    make,
    data,
    calls,
    token,
    connect,
    enable,
    access,
    setHook: (v) => {
      hook = v;
    },
    setClock: (v) => {
      clock = v;
    }
  };
}

test(
  'SimpleFIN disabled by default, encrypted one-time claim, map, durable exact import and corrections',
  { skip: !database },
  async (t) => {
    const f = await fixture(t);
    assert.equal((await f.sf.status()).enabled, false);
    await f.sf.tick();
    assert.equal(f.calls.length, 0);
    const a = await f.connect();
    const s = await f.sf.status();
    assert(s.verified);
    assert(!JSON.stringify(s).includes('synthetic-password'));
    assert(!JSON.stringify((await f.pool.query('SELECT * FROM app_settings')).rows).includes('synthetic-password'));
    assert(
      !JSON.stringify((await f.pool.query('SELECT * FROM encrypted_credentials')).rows).includes('synthetic-password')
    );
    await f.sf.mapAccount({ key: a.key, confirmNewAccount: true });
    assert.equal((await f.store.listAccounts()).length, 1);
    await f.sf.tick();
    assert.equal((await f.store.listTransactions()).length, 0);
    await f.enable();
    await f.sf.tick();
    let tx = (await f.store.listTransactions())[0];
    assert.equal(tx.amountMinor, '-1234');
    assert.equal((await f.store.listAccounts())[0].balanceMinor, '12010');
    await f.store.correctTransaction(tx.id, {
      category: 'Groceries',
      note: 'Manual note',
      splits: [{ category: 'Groceries', amountMinor: '-1234' }]
    });
    await f.make().tick();
    tx = await f.store.getTransaction(tx.id);
    assert.equal((await f.store.listTransactions()).length, 1);
    assert.equal(tx.category, 'Groceries');
    assert.equal(tx.note, 'Manual note');
    assert.equal(tx.splits[0].amountMinor, '-1234');
    assert.equal(tx.manuallyCorrected, true);
    assert((await f.pool.query('SELECT * FROM provider_observations')).rowCount >= 1);
    await assert.rejects(f.pool.query('DELETE FROM simplefin_fetches'), /immutable/);
    await f.sf.save({ enabled: false, backfillDays: 30 });
    const before = f.calls.length;
    await f.sf.tick();
    assert.equal(f.calls.length, before);
    assert.equal((await f.store.listTransactions()).length, 1);
    const wrong = f.make({
      config: { ...f.config, appSecret: randomBytes(32).toString('base64') }
    });
    assert.equal((await wrong.status()).credentialsAvailable, false);
    await assert.rejects(wrong.discover(), /credentials_unavailable/);
    const replacement = randomBytes(32).toString('base64');
    await f.settings.rotateSecrets(replacement);
    const restored = f.make({
      config: { ...f.config, appSecret: replacement }
    });
    assert.equal((await restored.snapshot()).accessUrl, f.access);
  }
);
test(
  'SimpleFIN claim replay and ambiguous outcomes survive restart without another POST',
  { skip: !database },
  async (t) => {
    const f = await fixture(t);
    const tok = f.token();
    let posted = 0;
    f.setHook(async (_u, o) => {
      if (o?.method === 'POST') {
        posted++;
        throw Error(`network error ${f.access}`);
      }
    });
    await assert.rejects(f.sf.connect({ token: tok }), /Revoke/);
    await assert.rejects(f.make().connect({ token: tok }), /already_attempted/);
    assert.equal(posted, 1);
    assert.equal((await f.sf.status()).configured, false);
    assert(!JSON.stringify(await f.sf.status()).includes('synthetic-password'));
    f.setHook(undefined);
    await f.sf.connect({ token: f.token() });
    await assert.rejects(f.sf.connect({ token: f.token() }), /disconnect/);
    await f.sf.disconnect({ confirm: true });
    assert.equal((await f.sf.status()).configured, false);
    assert.equal((await f.pool.query("SELECT * FROM encrypted_credentials WHERE provider='simplefin'")).rowCount, 0);
  }
);
test(
  'SimpleFIN cross-source mappings and historical relinking are blocked; direct integration stays default',
  { skip: !database },
  async (t) => {
    const f = await fixture(t, 'api.redbark.com');
    f.data.accounts[0].extra = { redbark_account_id: 'acct_One' };
    const a = await f.connect();
    await f.settings.setSecret('redbark.apiKey', 'redbark', 'synthetic-direct-key');
    await assert.rejects(f.sf.mapAccount({ key: a.key, confirmNewAccount: true }), /direct_source_active/);
    await f.settings.clearSecret('redbark.apiKey', 'redbark');
    await f.sf.mapAccount({ key: a.key, confirmNewAccount: true });
    await assert.rejects(
      f.store.ingestBatch({
        account: { id: 'acct_One', name: 'Direct', currency: 'AUD' },
        transactions: [
          {
            sourceId: 'direct1',
            amountMinor: '-100',
            date: '2026-10-01',
            description: 'Fictional',
            status: 'posted'
          }
        ]
      }),
      /another import source/
    );
    const directCalls = [];
    const direct = createRedbarkIntegration({
      pool: f.pool,
      store: f.store,
      config: f.config,
      getRedbarkConfig: async () => ({ redbarkApiKey: 'synthetic' }),
      fetchImpl: async (url) => {
        directCalls.push(String(url));
        return Response.json({
          data: [
            {
              id: 'acct_One',
              category: 'banking',
              currency: 'AUD',
              name: 'Fictional'
            }
          ],
          next_page_url: null
        });
      }
    });
    await direct.init();
    await direct.testConnection();
    await direct.tick();
    assert.equal(directCalls.length, 2, 'no balance or transaction fetch for owned account');
    await f.sf.disconnect({ confirm: true });
    await f.connect();
    const b = (await f.sf.status()).accounts[0];
    await assert.rejects(f.sf.mapAccount({ key: b.key, confirmNewAccount: true }), /historical_source_conflict/);
    assert.equal((await f.store.listAccounts()).length, 1);
  }
);
test(
  'SimpleFIN stale discovery and in-flight import are fenced by settings changes',
  { skip: !database },
  async (t) => {
    const f = await fixture(t);
    const a = await f.connect();
    await f.sf.mapAccount({ key: a.key, confirmNewAccount: true });
    await f.enable();
    let release, started;
    const gate = new Promise((r) => {
      started = r;
    });
    f.setHook(async (_u, o) => {
      if (o?.method !== 'POST') {
        started();
        await new Promise((r) => {
          release = r;
        });
      }
    });
    const running = f.sf.tick();
    await gate;
    await f.sf.save({ enabled: false, backfillDays: 30 });
    release();
    await running;
    assert.equal((await f.store.listTransactions()).length, 0);
    assert.equal((await f.pool.query('SELECT * FROM simplefin_fetches')).rowCount, 0);
    let go, begin;
    const seen = new Promise((r) => {
      begin = r;
    });
    f.setHook(async () => {
      begin();
      await new Promise((r) => {
        go = r;
      });
    });
    const discovery = f.sf.discover();
    await seen;
    await f.sf.disconnect({ confirm: true });
    go();
    await assert.rejects(discovery, /configuration_changed/);
    assert.equal((await f.sf.status()).configured, false);
  }
);
test(
  'SimpleFIN provider errors, response caps, rate limit, pending and partial coverage are visible',
  { skip: !database },
  async (t) => {
    const f = await fixture(t);
    const a = await f.connect();
    await f.sf.mapAccount({ key: a.key, confirmNewAccount: true });
    await f.enable();
    f.data.errors = ['<b>Reconnect</b> synthetic-password'];
    f.data.accounts[0].transactions.push({
      id: 'pending',
      posted: 0,
      pending: true,
      amount: '-2.00',
      description: 'Not posted'
    });
    await f.sf.tick();
    assert.equal((await f.store.listTransactions()).length, 1);
    assert.equal((await f.sf.status()).lastError, 'simplefin_provider_partial');
    assert.equal((await f.sf.status()).providerErrors[0], 'Reconnect [redacted]');
    assert.equal((await f.store.listAccounts())[0].coverage.truncated, true);
    f.data.errors = [];
    f.setHook(async () => ({
      status: 429,
      headers: { 'retry-after': '600' },
      body: ''
    }));
    await f.sf.tick();
    const before = f.calls.length;
    await f.sf.tick();
    assert.equal(f.calls.length, before);
    assert.equal((await f.sf.status()).lastError, 'simplefin_http_429');
    await f.pool.query('UPDATE simplefin_state SET next_attempt=NULL');
    await f.pool.query('UPDATE simplefin_jobs SET available_at=now()');
    f.setHook(undefined);
    const original = f.data.accounts[0].transactions[0];
    f.data.accounts[0].transactions = Array.from({ length: 2000 }, (_, i) => ({
      ...original,
      id: `bulk-${i}`
    }));
    await f.sf.tick();
    assert.equal((await f.sf.status()).lastError, 'simplefin_limit_split');
    assert.equal((await f.store.listTransactions()).length, 1, 'capped response never ingested as complete');
    assert((await f.pool.query("SELECT * FROM simplefin_jobs WHERE status='split'")).rowCount >= 1);
  }
);
test(
  'SimpleFIN malformed identity/currency/window payloads roll back without ledger corruption',
  { skip: !database },
  async (t) => {
    const f = await fixture(t);
    const a = await f.connect();
    await f.sf.mapAccount({ key: a.key, confirmNewAccount: true });
    await f.enable();
    f.data.accounts[0].transactions[0].amount = '1.999';
    await f.sf.tick();
    assert.equal((await f.store.listTransactions()).length, 0);
    assert.equal((await f.sf.status()).lastError, 'simplefin_invalid_amount');
    await f.pool.query('UPDATE simplefin_state SET next_attempt=NULL');
    await f.pool.query('UPDATE simplefin_jobs SET available_at=now()');
    f.data.accounts[0].transactions[0].amount = '1.00';
    f.data.accounts[0].currency = 'USD';
    await f.sf.tick();
    assert.equal((await f.sf.status()).lastError, 'simplefin_account_identity_changed');
    assert.equal((await f.store.listAccounts())[0].currency, 'AUD');
  }
);
test(
  'SimpleFIN admin-only real HTTP routes enforce origin, a strict body, rate limits and secret masking',
  { skip: !database },
  async (t) => {
    const f = await fixture(t);
    const auth = {
      session: async (req) =>
        req.headers['x-test-role'] ? { id: 'synthetic', role: req.headers['x-test-role'] } : null
    };
    const app = createApp({
      store: f.store,
      settings: f.settings,
      config: f.config,
      simplefin: f.sf,
      auth
    });
    const server = app.start();
    await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
    t.after(() => new Promise((r) => server.close(r)));
    const base = `http://127.0.0.1:${server.address().port}`;
    const req = (path = '', body, role = 'admin', origin = f.config.origin) =>
      fetch(`${base}/api/settings/simplefin${path}`, {
        method: body ? 'POST' : 'GET',
        headers: {
          'x-test-role': role,
          Origin: origin,
          'Content-Type': 'application/json'
        },
        body: body ? JSON.stringify(body) : undefined
      });
    for (const path of ['', '/connect', '/disconnect', '/test', '/map', '/backfill']) {
      const response = await req(path, path ? {} : undefined, 'member');
      assert.equal(response.status, 403);
    }

    assert.equal((await req('/connect', { token: f.token() }, 'admin', 'https://evil.test')).status, 403);
    assert.equal((await req('/connect', { token: f.token(), acknowledgeAccess: true })).status, 400);
    const response = await req('/connect', { token: f.token() });
    assert.equal(response.status, 200);
    assert(!(await response.text()).includes('synthetic-password'));
    for (let i = 0; i < 5; i++) {
      await req('/test', {});
    }

    assert.equal((await req('/test', {})).status, 429);
  }
);

test(
  'SimpleFIN preserves raw provenance with recursive secret redaction and never loses sanitized error presence',
  { skip: !database },
  async (t) => {
    const f = await fixture(t);
    f.data.accounts[0].transactions[0].transacted_at = f.data.accounts[0].transactions[0].posted - 100;
    f.data.accounts[0].transactions[0].extra = {
      original_reference: 'bank-reference',
      nested: { credential: f.access, password: 'synthetic-password' }
    };
    const a = await f.connect();
    assert(
      !JSON.stringify(await f.sf.status()).includes('bank-reference'),
      'discovery never returns or stores raw transactions as settings metadata'
    );
    await f.sf.mapAccount({ key: a.key, confirmNewAccount: true });
    await f.enable();
    f.data.errors = ['<br>'];
    f.data.accounts[0].errors = ['\u0001'];
    await f.sf.tick();
    assert.equal((await f.sf.status()).lastError, 'simplefin_provider_partial');
    assert.equal((await f.sf.status()).providerErrors.length, 2);
    const raw = (await f.pool.query('SELECT raw FROM simplefin_fetches ORDER BY id LIMIT 1')).rows[0].raw;
    assert.equal(raw.account.transactions[0].id, 'tx-one');
    assert.equal(raw.account.transactions[0].amount, '-12.34');
    assert.equal(raw.account.transactions[0].extra.original_reference, 'bank-reference');
    assert(raw.account.transactions[0].transacted_at);
    assert(!JSON.stringify(raw).includes('synthetic-password'));
    assert(!JSON.stringify(raw).includes(f.access));
    assert.equal(raw.normalized.transactions[0].amountMinor, '-1234');
  }
);

test(
  'SimpleFIN identical transaction IDs in different accounts remain distinct and window boundaries are gap-free',
  { skip: !database },
  async (t) => {
    const f = await fixture(t);
    const original = f.data.accounts[0];
    const end = Math.floor(Date.now() / 1000) + 1,
      start = end - 30 * 86400,
      mid = start + Math.floor((end - start) / 2);
    original.transactions = [
      {
        id: 'same',
        posted: start,
        amount: '-1.00',
        description: 'Start inclusive'
      },
      {
        id: 'middle',
        posted: mid,
        amount: '-2.00',
        description: 'Split start'
      },
      { id: 'end', posted: end, amount: '-3.00', description: 'End exclusive' }
    ];
    f.data.accounts.push({ ...structuredClone(original), id: 'account-two' });
    await f.connect();
    const accounts = (await f.sf.status()).accounts;
    for (const a of accounts) {
      await f.sf.mapAccount({ key: a.key, confirmNewAccount: true });
    }

    await f.enable();
    await f.pool.query('DELETE FROM simplefin_jobs');
    const s = await f.sf.snapshot();
    for (const a of accounts) {
      for (const [left, right] of [
        [start, mid],
        [mid, end]
      ]) {
        await f.pool.query(
          'INSERT INTO simplefin_jobs(dedupe_key,source_id,remote_key,start_second,end_second) VALUES($1,$2,$3,$4,$5)',
          [`${a.key}:${left}`, s.sourceId, a.key, left, right]
        );
      }
    }

    for (let i = 0; i < 4; i++) {
      await f.sf.tick();
    }

    const transactions = await f.store.listTransactions();
    assert.equal(transactions.length, 4);
    assert.equal(transactions.filter((x) => x.description === 'Start inclusive').length, 2);
    assert.equal(transactions.filter((x) => x.description === 'Split start').length, 2);
    assert.equal(new Set(transactions.map((x) => x.accountId)).size, 2);
    assert.equal(
      transactions.some((x) => x.description === 'End exclusive'),
      false
    );
  }
);

test(
  'SimpleFIN PostgreSQL outage performs no provider read and durable jobs resume after recovery',
  {
    skip: !database || !process.env.DOLPHINO_DB_SHUTDOWN_TEST,
    timeout: 30000
  },
  async (t) => {
    assert.equal(process.env.DOLPHINO_TEST_PG_ISOLATED, '1');
    const f = await fixture(t),
      a = await f.connect();
    await f.sf.mapAccount({ key: a.key, confirmNewAccount: true });
    await f.enable();
    const calls = f.calls.length,
      pgctl = process.env.DOLPHINO_TEST_PG_CTL,
      data = process.env.DOLPHINO_TEST_PG_DATA_DIR;
    assert(pgctl && data && process.env.PGPORT);
    try {
      execFileSync(pgctl, ['-D', data, '-m', 'fast', '-w', 'stop'], {
        stdio: 'pipe'
      });
      await assert.rejects(f.sf.status());
      await assert.rejects(f.sf.tick());
      assert.equal(f.calls.length, calls);
    } finally {
      execFileSync(
        pgctl,
        [
          '-D',
          data,
          '-l',
          `${data}/simplefin-restart.log`,
          '-o',
          `-h 127.0.0.1 -p ${process.env.PGPORT} -c unix_socket_directories=''`,
          '-w',
          'start'
        ],
        { stdio: 'pipe' }
      );
    }

    await f.make().tick();
    assert.equal((await f.store.listTransactions()).length, 1);
    assert.equal((await f.sf.status()).configured, true);
  }
);

test(
  'SimpleFIN missing accounts retain sanitized provider diagnostics and never advance coverage',
  { skip: !database },
  async (t) => {
    const f = await fixture(t),
      a = await f.connect();
    await f.sf.mapAccount({ key: a.key, confirmNewAccount: true });
    await f.enable();
    f.data.accounts = [];
    f.data.errors = ['Connection to Fictional bank may need attention. synthetic-password'];
    await f.sf.tick();
    const state = await f.sf.status();
    assert.equal(state.lastError, 'simplefin_account_missing_from_response');
    assert.equal(state.providerErrors.length, 1);
    assert(!state.providerErrors[0].includes('synthetic-password'));
    assert.equal((await f.store.listTransactions()).length, 0);
    assert.equal(state.lastSuccess, null);
  }
);

test(
  'SimpleFIN tombstones survive adapter initialization, purge evidence locally and prevent rediscovery or polling recreation',
  { skip: !database },
  async (t) => {
    const f = await fixture(t),
      found = await f.connect();
    await f.sf.mapAccount({ key: found.key, confirmNewAccount: true });
    await f.enable();
    await f.sf.tick();
    const account = (await f.store.listAccounts())[0];
    const { createHouseholdAuth } = await import('../src/lib/household-auth.mjs');
    const { createAccountLifecycle } = await import('../src/lib/account-lifecycle.mjs');
    await createHouseholdAuth({ pool: f.pool, config: f.config }).init();
    const user = (
      await f.pool.query(
        "INSERT INTO household_users(email,name,role,password_hash) VALUES('lifecycle@example.test','Synthetic admin','admin','unused-synthetic-hash') RETURNING id,role"
      )
    ).rows[0];
    const lifecycle = createAccountLifecycle(f.store, user);
    await lifecycle.change(account.id, {
      requestId: randomUUID(),
      revision: account.revision,
      action: 'freeze',
      reason: 'Freeze synthetic account'
    });
    f.data.accounts[0].balance = '125.00';
    f.setClock(Date.now() + 5 * 3600000);
    await f.sf.tick();
    assert.equal((await f.store.listAccounts())[0].balanceMinor, '12500');
    await lifecycle.change(account.id, {
      requestId: randomUUID(),
      revision: (await f.store.listAccounts())[0].revision,
      action: 'delete',
      reason: 'Delete synthetic account'
    });
    f.data.accounts[0].balance = '130.00';
    f.setClock(Date.now() + 10 * 3600000);
    await f.sf.tick();
    const hidden = (await lifecycle.listDeleted()).accounts[0];
    assert.equal(hidden.balanceMinor, '13000');
    const upstream = f.data.accounts;
    f.data.accounts = [];
    f.setClock(Date.now() + 15 * 3600000);
    await f.sf.tick();
    const retained = (await lifecycle.listDeleted()).accounts[0];
    assert.equal(retained.balanceMinor, hidden.balanceMinor);
    assert.deepEqual(retained.fetchedAt, hidden.fetchedAt);
    assert.equal((await f.pool.query('SELECT * FROM transactions')).rowCount > 0, true);
    f.data.accounts = upstream;
    const preview = await lifecycle.preview({ accountIds: [account.id] });
    assert.ok(preview.counts.simplefin_fetches > 0);
    // Init re-runs the adapter schema: evidence must still be immutable outside confirmed purge.
    await f.sf.init();
    await assert.rejects(f.pool.query('DELETE FROM simplefin_fetches'), /immutable/);
    await lifecycle.purge({
      requestId: randomUUID(),
      accountIds: [account.id],
      previewToken: preview.previewToken,
      confirmation: preview.confirmation
    });
    assert.equal((await f.pool.query('SELECT * FROM simplefin_fetches')).rowCount, 0);
    assert.deepEqual((await f.pool.query('SELECT metadata FROM simplefin_accounts')).rows[0].metadata, {});
    await f.sf.discover();
    assert.equal((await f.sf.status()).accounts.length, 0);
    const callCount = f.calls.length;
    f.setClock(Date.now() + 30 * 3600000);
    await f.sf.tick();
    assert.equal(f.calls.length, callCount);
    assert.equal((await f.store.listAccounts()).length, 0);
    assert.equal((await f.store.listTransactions()).length, 0);
  }
);
