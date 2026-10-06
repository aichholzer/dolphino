import { accountBalances } from '../../shared/account-balances.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { createApp, body } from '../src/app.mjs';
import { createRouteRegistrar } from '../src/http/router.mjs';
import { createSensitiveActionGuard } from '../src/http/security.mjs';
import { createFinanceQueries } from '../src/routes/finance-queries.mjs';

// This fixture records the HTTP contract before domain extraction, including
// intentional exceptions such as administrator-only classification suggestions.
test('domain route inventory preserves every method, path and access policy', async () => {
  const expected = JSON.parse(await readFile(new URL('./fixtures/route-contract.json', import.meta.url)));
  const actual = [];
  const route = (method, path, _handler, { access = 'admin', webhook = false } = {}) => {
    actual.push([method, path, access, ...(webhook ? [true] : [])]);
  };

  for (const filename of await readdir(new URL('../src/routes/', import.meta.url))) {
    const module = await import(new URL(`../src/routes/${filename}`, import.meta.url));
    for (const [name, register] of Object.entries(module)) {
      if (/^register.+Routes$/.test(name)) {
        register({ route });
      }
    }
  }

  const byEndpoint = (a, b) => `${a[0]} ${a[1]}`.localeCompare(`${b[0]} ${b[1]}`);
  assert.deepEqual(actual.sort(byEndpoint), expected.sort(byEndpoint));
  assert.equal(new Set(actual.map(([method, path]) => `${method} ${path}`)).size, actual.length);
});

test('unknown access policies fail closed during registration', () => {
  const route = createRouteRegistrar({});
  assert.throws(() => route('get', '/private', () => ({}), { access: 'finanical' }), /Unknown route access policy/);
});

test('body parser preserves raw bytes, rejects invalid JSON and bounds all requests', async () => {
  const raw = Buffer.from(' { "duplicate": 1, "duplicate": 2, "merchant": "Café 🐬" }\n');
  assert.deepEqual(await body(Readable.from([raw.subarray(0, 7), raw.subarray(7)]), true), raw);
  assert.deepEqual(await body(Readable.from([])), {});
  assert.deepEqual(await body(Readable.from([raw])), { duplicate: 2, merchant: 'Café 🐬' });
  await assert.rejects(body(Readable.from([Buffer.from('{invalid')])), { status: 400 });
  assert.equal((await body(Readable.from([Buffer.alloc(1048576)]), true)).length, 1048576);
  for (const rawMode of [false, true]) {
    await assert.rejects(body(Readable.from([Buffer.alloc(1048576), Buffer.from('x')]), rawMode), { status: 413 });
  }
});

async function startFixture(t) {
  const config = {
    mode: 'live',
    host: '127.0.0.1',
    port: 0,
    origin: 'https://dolphino.test',
    currency: 'AUD',
    timezone: 'Australia/Brisbane'
  };
  const calls = { login: 0, webhook: 0, settings: 0 };
  const store = {
    mode: 'live',
    pool: { query: async () => ({ rows: [] }) },
    listAccounts: async () => [{ id: 'private-account', name: 'Private' }],
    automaticClassificationCandidates: async () => []
  };
  const auth = {
    setupStatus: async () => ({ setupRequired: false }),
    session: async (req) =>
      req.headers['x-test-role'] ? { id: 'fixture-user', role: req.headers['x-test-role'] } : null,
    login: async () => {
      calls.login++;
      return { cookie: 'fixture=synthetic; HttpOnly', user: { id: 'fixture-user', role: 'admin' } };
    }
  };
  const integration = {
    receiveWebhook: async (raw, headers) => {
      calls.webhook++;
      assert(Buffer.isBuffer(raw));
      return { raw: raw.toString('base64'), signature: headers['x-synthetic-signature'] };
    }
  };
  const settings = {
    getPublicProvider: async () => {
      calls.settings++;
      return { configured: false };
    }
  };
  const app = createApp({ config, store, auth, integration, settings, simplefin: null });
  const server = await new Promise((resolve) => {
    const server = app.start(() => resolve(server));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const request = (path, { role, origin, ...options } = {}) =>
    fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      ...options,
      headers: {
        ...(role ? { 'x-test-role': role } : {}),
        ...(origin ? { Origin: origin } : {}),
        ...options.headers
      }
    });
  return { request, config, store, calls };
}

test('HTTP boundary retains default-admin guards, scoped financial access and headers', async (t) => {
  const { request, calls, store } = await startFixture(t);
  assert.equal((await request('/api/settings/provider')).status, 401);
  assert.equal((await request('/api/settings/provider', { role: 'member' })).status, 403);
  assert.equal(calls.settings, 0);
  const allowed = await request('/api/settings/provider', { role: 'admin' });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get('cache-control'), 'no-store');
  assert.equal(allowed.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(allowed.headers.get('x-frame-options'), 'DENY');
  assert.equal(allowed.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(allowed.headers.get('strict-transport-security'), 'max-age=31536000');
  assert.match(allowed.headers.get('permissions-policy'), /camera=\(\)/);
  assert.deepEqual(await (await request('/api/accounts', { role: 'member' })).json(), {
    accounts: [],
    accountBalances: []
  });
  assert.deepEqual(await (await request('/api/accounts', { role: 'admin' })).json(), {
    accounts: await store.listAccounts(),
    accountBalances: JSON.parse(JSON.stringify(accountBalances(await store.listAccounts())))
  });
  assert.equal((await request('/api/transactions/guessed/suggest', { role: 'member', method: 'POST' })).status, 403);
  store.listAccounts = async () => {
    throw Error('private database password');
  };

  const failure = await request('/api/accounts', { role: 'admin' });
  assert.equal(failure.status, 500);
  assert.deepEqual(await failure.json(), { error: 'Operation failed. Check configuration and database availability.' });
});

test('public auth writes still need exact Origin and strict request fields', async (t) => {
  const { request, calls, config } = await startFixture(t);
  for (const origin of [undefined, 'https://wrong.test', 'null']) {
    assert.equal((await request('/api/login', { method: 'POST', origin, body: '{}' })).status, 403);
  }

  assert.equal(calls.login, 0);
  for (const value of [
    '{invalid',
    '{}',
    JSON.stringify({ email: 'demo@example.test', password: 'synthetic', role: 'admin' })
  ]) {
    const response = await request('/api/login', { method: 'POST', origin: config.origin, body: value });
    assert.equal(response.status, 400);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }

  assert.equal(calls.login, 0);
  const login = await request('/api/login', {
    method: 'POST',
    origin: config.origin,
    body: JSON.stringify({ email: 'demo@example.test', password: 'synthetic' })
  });
  assert.equal(login.status, 200);
  assert.match(login.headers.get('set-cookie'), /HttpOnly/);
  assert.equal(calls.login, 1);
});

test('HTTP webhook is the public Origin exception and forwards original bounded bytes', async (t) => {
  const { request, calls } = await startFixture(t);
  const raw = Buffer.from(' { "duplicate": 1, "duplicate": 2, "merchant": "Café 🐬" }\n');
  const response = await request('/api/webhooks/redbark', {
    method: 'POST',
    body: raw,
    headers: { 'x-synthetic-signature': 'fixture-signature' }
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { raw: raw.toString('base64'), signature: 'fixture-signature' });
  assert.equal(calls.webhook, 1);
  const oversized = await request('/api/webhooks/redbark', { method: 'POST', body: Buffer.alloc(1048577) });
  assert.equal(oversized.status, 413);
  assert.equal(calls.webhook, 1);
});

test('sensitive action guards are live-only, shared by action and independent per app', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 100000 });
  const guard = createSensitiveActionGuard({ mode: 'live' });
  assert.throws(() => createSensitiveActionGuard({ mode: 'demo' })('save'), { status: 409 });
  for (let i = 0; i < 5; i++) {
    guard('save');
  }

  assert.throws(() => guard('save'), { status: 429 });
  guard('test');
  createSensitiveActionGuard({ mode: 'live' })('save');
  t.mock.timers.tick(60000);
  guard('save');
});

test('finance query adaptation preserves exact scopes and minor-unit report values', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-30T15:30:00Z') });
  const { ledger, filters, report } = createFinanceQueries({
    config: { currency: 'AUD', timezone: 'Australia/Brisbane' }
  });
  assert.throws(() => ledger({}), /request-scoped access store/);
  assert.deepEqual(filters({ query: {} }), { month: '2026-10', months: 1, currency: 'AUD' });
  for (const query of [{ ids: '' }, { allHistory: 'true' }, { from: '2026-09-01', to: '2026-09-30' }]) {
    assert.equal(filters({ query }).month, undefined);
  }

  for (const query of [
    { month: '2026-13' },
    { currency: 'aud' },
    { months: '7' },
    { from: '2026-02-30' },
    { from: '2026-10-02', to: '2026-10-01' }
  ]) {
    assert.throws(() => filters({ query }), { status: 400 });
  }

  assert.equal(filters({ query: { months: '5' } }).months, 5);
  const raw = {
    expensesMinor: '9007199254740993',
    daily: [{ date: '2026-09-01', spentMinor: '123' }],
    categories: [{ category: 'Food', spentMinor: '123' }]
  };
  const accessStore = {
    report: async (query) => {
      assert.equal(query.month, '2026-09');
      return raw;
    }
  };
  assert.deepEqual(await report({ query: { month: '2026-09' }, accessStore }), {
    ...raw,
    trend: [{ ...raw.daily[0], label: '2026-09-01' }],
    categories: [{ ...raw.categories[0], amountMinor: '123' }]
  });
  for (const query of [{ allHistory: 'true' }, { from: '2026-09-01' }, { to: '2026-09-30' }]) {
    await assert.rejects(report({ query, accessStore }), { status: 400 });
  }
});

test('all domain endpoints are mounted behind the shared HTTP boundary', async (t) => {
  const { request } = await startFixture(t);
  const contract = JSON.parse(await readFile(new URL('./fixtures/route-contract.json', import.meta.url)));
  for (const [method, path, access, webhook] of contract) {
    const response = await request(path.replace(/:[a-z]+/g, 'fixture'), {
      method: method.toUpperCase(),
      ...(method === 'get' ? {} : { body: '{}' })
    });
    const expectedStatus = access === 'public' ? (method === 'get' || webhook ? 200 : 403) : 401;
    assert.equal(response.status, expectedStatus, `${method.toUpperCase()} ${path}`);
    assert.equal(response.headers.get('x-frame-options'), 'DENY', path);
    assert.equal(response.headers.get('cache-control'), 'no-store', path);
  }
});
