import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  parsePocketSmithJson,
  pocketSmithMoney,
  pocketSmithId,
  pocketSmithDate,
  pocketSmithTimestamp,
  normalizePocketSmithAccounts,
  normalizePocketSmithTransaction,
  pocketSmithTagPlan,
  pocketSmithAccountId
} from '../src/lib/pocketsmith-data.mjs';
import {
  pocketSmithTransactionUrl,
  pocketSmithNextPage,
  pocketSmithRetryDelay,
  readPocketSmithTransactionPages
} from '../src/lib/pocketsmith-pages.mjs';
import { PocketSmithClient, pocketSmithReadUrl, securePocketSmithRequest } from '../src/lib/pocketsmith-client.mjs';
import { pocketAccount, pocketTransaction, testPocketSmithKey } from './helpers/pocketsmith-fixture.mjs';
const decoded = (value) => parsePocketSmithJson(JSON.stringify(value));
const options = { userId: '42', fetchedAt: '2026-10-02T00:00:00Z' };
const account = () => normalizePocketSmithAccounts(decoded([pocketAccount()]), [], options)[0];
const query = { transactionAccountId: '9001', startDate: '2026-10-01', endDate: '2026-10-03' };
const url = () => pocketSmithTransactionUrl(query);
const headers = (total, next) => ({
  total: String(total),
  'per-page': '500',
  ...(next ? { link: `<${next}>; rel="next"` } : {})
});

test('PocketSmith JSON preserves exact numeric lexemes, rejects duplicate and dangerous keys, and bounds complexity', () => {
  const data = parsePocketSmithJson('{"id":9223372036854775807,"amount":92233720368547758.07,"exp":-1.23e+2}');
  assert.equal(data.id, '9223372036854775807');
  assert.equal(data.amount, '92233720368547758.07');
  assert.equal(data.exp, '-1.23e+2');
  for (const body of [
    '{"amount":1,"amount":2}',
    '{"id":1,"\\u0069d":2}',
    '{"__proto__":{}}',
    '{"constructor":1}',
    'nullx',
    '['.repeat(40) + '0' + ']'.repeat(40),
    JSON.stringify('a'.repeat(2 * 1024 * 1024))
  ]) {
    assert.throws(() => parsePocketSmithJson(body));
  }

  assert.deepEqual(parsePocketSmithJson('{"a":[{"x":1},{"x":2}],"b":true}'), { a: [{ x: '1' }, { x: '2' }], b: true });
});

test('PocketSmith money keeps exact signed PostgreSQL bounds across currencies and exponents without rounding', () => {
  for (const [value, currency, expected] of [
    ['92233720368547758.07', 'AUD', '9223372036854775807'],
    ['-92233720368547758.08', 'AUD', '-9223372036854775808'],
    ['-1.234e1', 'AUD', '-1234'],
    ['1.2300', 'AUD', '123'],
    ['123.000', 'JPY', '123'],
    ['1.234', 'KWD', '1234'],
    ['-0', 'AUD', '0']
  ]) {
    assert.equal(pocketSmithMoney(value, currency), expected);
  }

  for (const value of [
    1.23,
    'NaN',
    'Infinity',
    '+1',
    '01',
    '1.001',
    '1e999',
    '1e-100',
    '92233720368547758.08',
    '-92233720368547758.09'
  ]) {
    assert.throws(() => pocketSmithMoney(value, 'AUD'));
  }

  assert.throws(() => pocketSmithMoney('1', 'XYZ'));
});

test('PocketSmith identity and dates reject unsafe numbers, ambiguous dates and nonexistent calendar days', () => {
  assert.equal(pocketSmithId('9223372036854775807'), '9223372036854775807');
  for (const id of [42, '0', '-1', '01', '1e2', '9223372036854775808', '../42']) {
    assert.throws(() => pocketSmithId(id));
  }

  assert.equal(pocketSmithDate('2024-02-29'), '2024-02-29');
  for (const date of ['2026-02-29', '2026-13-01', '0000-01-01', '10/02/2026', '2026-10-02T00:00:00Z']) {
    assert.throws(() => pocketSmithDate(date));
  }

  assert.equal(pocketSmithTimestamp('2026-10-02T12:00:00.123456+13:00'), '2026-10-02T12:00:00.123456+13:00');
  for (const timestamp of ['2026-10-02', '2026-02-30T00:00:00Z', '2026-10-02T24:00:00Z', '2026-10-02T12:00:00']) {
    assert.throws(() => pocketSmithTimestamp(timestamp));
  }
});

test('PocketSmith native accounts never double-count grouped balances or adopt converted and safe balances', () => {
  const native = decoded([pocketAccount(), pocketAccount(9002, { current_balance: -20 })]);
  const groups = decoded([
    {
      id: 700,
      title: 'Group',
      currency_code: 'AUD',
      current_balance: 999999,
      transaction_accounts: native,
      primary_transaction_account: native[0]
    }
  ]);
  const result = normalizePocketSmithAccounts(native, groups, options);
  assert.equal(result.length, 2);
  assert.equal(result[0].balanceMinor, '123456');
  assert.equal(result[1].balanceMinor, '-2000');
  assert.equal(result[0].balanceAt, null);
  assert.equal(result[0].balanceDate, '2026-10-02');
  assert.equal(result[0].group.id, '700');
  assert.equal(result[0].remoteId, '9001');
  assert.equal(result[0].balanceMetadata.currentBalanceInBaseCurrency, '9876.54');
  assert.equal(result[0].balanceMetadata.safeBalanceMinor, '100000');
  assert.notEqual(pocketSmithAccountId('43', '9001'), result[0].id);
  assert.throws(() => normalizePocketSmithAccounts([...native, native[0]], groups, options));
  assert.throws(() => normalizePocketSmithAccounts(native, [...groups, { ...groups[0], id: '701' }], options));
  assert.throws(() => normalizePocketSmithAccounts(native, [{ ...groups[0], currency_code: 'USD' }], options));
});

test('PocketSmith transactions validate signed native currency amounts, review and transfer/refund semantics', () => {
  const normalize = (changes = {}) =>
    normalizePocketSmithTransaction(decoded(pocketTransaction(101, changes)), account(), options);
  const expense = normalize();
  assert.equal(expense.observation.amountMinor, '-1234');
  assert.equal(expense.observation.kind, 'expense');
  assert.deepEqual(expense.tags, ['conference', 'work']);
  assert.equal(expense.observation.note, undefined);
  assert.equal(normalize({ status: 'pending' }).observation.status, 'pending');
  assert.equal(normalize({ amount: 12.34, type: 'credit' }).observation.kind, 'refund');
  assert.equal(normalize({ is_transfer: true }).observation.kind, 'transfer');
  assert.equal(
    normalize({ category: { id: 8, title: 'Salary', refund_behaviour: 'debits_are_deductions' } }).observation.kind,
    'income'
  );
  for (const changes of [
    { status: undefined },
    { type: 'credit' },
    { is_transfer: 'false' },
    { needs_review: 'true' },
    { transaction_account: pocketAccount(9002) },
    { transaction_account: pocketAccount(9001, { currency_code: 'USD' }) },
    { labels: ['a\nsecret'] },
    { amount: -1.001 }
  ]) {
    assert.throws(() => normalize(changes));
  }
});

test('PocketSmith labels are additive and honor manual removals and tag capacity', () => {
  const current = Array.from({ length: 19 }, (_, i) => `local-${i}`);
  const plan = pocketSmithTagPlan(['work', 'travel', 'conference'], current, [{ tag: 'work', removed: true }]);
  assert.deepEqual(plan.suppressed, ['work']);
  assert.deepEqual(plan.added, ['conference']);
  assert.deepEqual(plan.capacitySkipped, ['travel']);
  assert.equal(plan.tags.length, 20);
  assert.deepEqual(pocketSmithTagPlan([], ['local'], []).tags, ['local']);
});

test('PocketSmith query windows require both dates and preserve incremental offsets', () => {
  assert.equal(url().searchParams.get('per_page'), '500');
  assert.equal(pocketSmithTransactionUrl({ transactionAccountId: '9' }).searchParams.has('start_date'), false);
  assert.throws(() => pocketSmithTransactionUrl({ transactionAccountId: '9', startDate: '2026-01-01' }));
  assert.throws(() => pocketSmithTransactionUrl({ ...query, endDate: '2026-09-01' }));
  assert.equal(
    pocketSmithTransactionUrl({ ...query, updatedSince: '2026-10-02T12:00:00+13:00' }).searchParams.get(
      'updated_since'
    ),
    '2026-10-02T12:00:00+13:00'
  );
});

test('PocketSmith pagination rejects SSRF, changed scopes, malformed headers, skipped pages and truncation', () => {
  const next = url();
  next.searchParams.set('page', '2');
  assert.equal(pocketSmithNextPage(url().href, headers(501, next.href), 500).searchParams.get('page'), '2');
  assert.equal(pocketSmithNextPage(next.href, headers(501), 1), null);
  for (const value of [
    'https://evil.example/collect',
    next.href.replace('/9001/', '/9002/'),
    next.href.replace('page=2', 'page=3'),
    next.href + '&extra=secret',
    next.href.replace('2026-10-01', '2026-09-01'),
    next.href.replace('api.pocketsmith.com', 'user:secret@api.pocketsmith.com')
  ]) {
    assert.throws(() => pocketSmithNextPage(url().href, headers(501, value), 500));
  }

  assert.throws(() => pocketSmithNextPage(url().href, headers(501), 500));
  assert.throws(() => pocketSmithNextPage(url().href, {}, 30));
  assert.throws(() => pocketSmithNextPage(url().href, headers(501, next.href), 499));
  assert.throws(() => pocketSmithNextPage(url().href, { ...headers(501), link: 'garbage' }, 500));
});

test('PocketSmith paged reads return no partial result when later pages fail, repeat or change totals', async () => {
  const rows = Array.from({ length: 501 }, (_, i) => pocketTransaction(i + 1));
  let calls = 0;
  const read = async (pageUrl) => {
    calls++;
    const page = Number(pageUrl.searchParams.get('page'));
    const next = new URL(pageUrl);
    next.searchParams.set('page', '2');
    return {
      status: 200,
      body: JSON.stringify(page === 1 ? rows.slice(0, 500) : rows.slice(500)),
      headers: headers(501, page === 1 ? next.href : null)
    };
  };

  const result = await readPocketSmithTransactionPages(query, { read });
  assert.equal(result.records.length, 501);
  assert.equal(result.pages.length, 2);
  assert.equal(calls, 2);
  for (const failure of [
    { status: 503, body: testPocketSmithKey },
    { status: 200, body: JSON.stringify([rows[0]]), headers: headers(501) },
    { status: 200, body: JSON.stringify([rows[500]]), headers: headers(502) }
  ]) {
    await assert.rejects(
      readPocketSmithTransactionPages(query, {
        read: async (u) => (u.searchParams.get('page') === '1' ? read(u) : failure)
      })
    );
  }

  await assert.rejects(readPocketSmithTransactionPages(query, { read, maxPages: 1 }), /page_limit/);
  await assert.rejects(readPocketSmithTransactionPages({ transactionAccountId: '9' }, { read }), /bounded_window/);
  await assert.rejects(readPocketSmithTransactionPages({ ...query, page: 2 }, { read }), /first_page/);
});

test('PocketSmith retry policy honors seconds and HTTP dates without claiming provider rate limits', () => {
  assert.equal(pocketSmithRetryDelay({ 'retry-after': '864000' }, 0, 0), 864000000);
  assert.equal(pocketSmithRetryDelay({ 'retry-after': new Date(120000).toUTCString() }, 0, 0), 120000);
  assert.equal(pocketSmithRetryDelay({ 'retry-after': 'garbage' }, 2, 0), 240000);
});

test('PocketSmith client masks echoed keys including escaped strings and never returns provider error bodies', async () => {
  const escaped = [...testPocketSmithKey].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
  const client = new PocketSmithClient(testPocketSmithKey, {
    request: async () => ({ status: 200, body: `{"id":42,"echo":"${escaped}","amount":92233720368547758.07}` })
  });
  const value = await client.json('/v2/me');
  assert.equal(value.echo, '[redacted]');
  assert.equal(value.amount, '92233720368547758.07');
  const errorClient = new PocketSmithClient(testPocketSmithKey, {
    request: async () => ({ status: 401, body: testPocketSmithKey })
  });
  await assert.rejects(
    errorClient.json('/v2/me'),
    (e) => e.code === 'pocketsmith_access_denied' && !e.message.includes(testPocketSmithKey)
  );
});

test('PocketSmith credential destinations and HTTP methods are fixed and private DNS is blocked', async () => {
  for (const value of [
    'http://api.pocketsmith.com/v2/me',
    'https://api.pocketsmith.com.evil.test/v2/me',
    'https://127.0.0.1/v2/me',
    'https://api.pocketsmith.com/v2/transactions/1',
    'https://api.pocketsmith.com/v2/me?key=secret',
    'https://u:p@api.pocketsmith.com/v2/me',
    'https://api.pocketsmith.com:444/v2/me'
  ]) {
    assert.throws(() => pocketSmithReadUrl(value));
  }

  let called = false;
  for (const address of ['127.0.0.1', '169.254.169.254', '10.0.0.1', '::1', 'fc00::1']) {
    await assert.rejects(
      securePocketSmithRequest(new URL('https://api.pocketsmith.com/v2/me'), {
        key: testPocketSmithKey,
        lookupImpl: async () => [{ address, family: address.includes(':') ? 6 : 4 }],
        requestImpl: () => {
          called = true;
        }
      })
    );
  }

  assert.equal(called, false);
  let captured;
  await securePocketSmithRequest(new URL('https://api.pocketsmith.com/v2/me'), {
    key: testPocketSmithKey,
    method: 'POST',
    lookupImpl: async () => [{ address: '8.8.8.8', family: 4 }],
    requestImpl: (options, callback) => {
      captured = options;
      const req = new EventEmitter();
      req.destroy = () => {};
      req.end = () =>
        queueMicrotask(() => {
          const res = new PassThrough();
          res.statusCode = 200;
          res.headers = {};
          callback(res);
          res.end('{}');
        });
      return req;
    }
  });
  assert.equal(captured.method, 'GET');
  assert.equal(captured.headers['X-Developer-Key'], testPocketSmithKey);
  assert.equal(captured.servername, 'api.pocketsmith.com');
  assert.equal(captured.rejectUnauthorized, true);
  captured.lookup('api.pocketsmith.com', {}, (_error, address) => assert.equal(address, '8.8.8.8'));
});
