import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  RedbarkClient,
  describeRedbarkError,
  verifyRedbarkSignature,
  parseThinEvent,
  normalizeTransaction,
  boundedDates
} from '../src/lib/redbark.mjs';
const reply = (data, next = null, headers = {}) =>
  new Response(JSON.stringify({ data, next_page_url: next }), { headers });
test('thin signature verifies exact bytes, rotated signatures, and rejects replay/tampering', () => {
  const now = Date.now(),
    t = Math.floor(now / 1000),
    body = Buffer.from('{ "id": 1 }');
  const sig = createHmac('sha256', 'secret').update(`${t}.`).update(body).digest('hex');
  assert.equal(verifyRedbarkSignature(`t=${t},v1=${'0'.repeat(64)},v1=${sig}`, body, 'secret', now), true);
  assert.equal(verifyRedbarkSignature(`t=${t},v1=${sig}`, Buffer.from('{"id":1}'), 'secret', now), false);
  assert.equal(verifyRedbarkSignature(`t=${t},v1=${sig}`, body, 'secret', now + 301000), false);
  assert.equal(verifyRedbarkSignature(`t=${t},t=${t},v1=${sig}`, body, 'secret', now), false);
});
test('reject full webhook contract instead of confusing raw and tagged IDs', () => {
  assert.throws(() =>
    parseThinEvent(
      Buffer.from(
        JSON.stringify({
          id: 'uuid',
          object: 'event',
          type: 'transactions.synced',
          created: 123,
          data: { new: [] }
        })
      )
    )
  );
  assert.equal(
    parseThinEvent(
      Buffer.from(
        JSON.stringify({
          id: 'evt_123',
          object: 'event',
          type: 'transactions.synced',
          created: new Date().toISOString(),
          livemode: true
        })
      )
    ).id,
    'evt_123'
  );
});
test('pagination follows opaque page URL with credentials confined to origin', async () => {
  const calls = [];
  const client = new RedbarkClient({
    apiKey: 'mock-secret',
    fetchImpl: async (url, options) => {
      calls.push(url);
      assert.equal(options.headers['Redbark-Version'], '2026-10-01.wattle');
      return calls.length === 1
        ? reply([{ id: 'a' }], 'https://api.redbark.com/v2/accounts?page=opaque')
        : reply([{ id: 'b' }]);
    }
  });
  assert.equal((await client.accounts()).length, 2);
  assert.equal(calls[1], 'https://api.redbark.com/v2/accounts?page=opaque');
  await assert.rejects(client.request('https://evil.example/v2/accounts'), /unsafe_provider_url/);
});
test('truncated windows split into nonoverlapping bounded dates; one day fails visibly', async () => {
  const calls = [];
  const client = new RedbarkClient({
    apiKey: 'mock',
    fetchImpl: async (url) => {
      const u = new URL(url);
      calls.push(u);
      assert.equal(u.searchParams.get('account'), 'acct_A');
      assert.equal(u.searchParams.get('limit'), '100');
      return u.searchParams.get('from') === u.searchParams.get('to')
        ? reply([{ id: u.searchParams.get('from') }])
        : reply([], null, { 'X-Redbark-Truncated': 'true' });
    }
  });
  assert.deepEqual(
    (await client.transactions('acct_A', '2026-09-01', '2026-09-02')).map((x) => x.id),
    ['2026-09-01', '2026-09-02']
  );
  client.fetch = async () => reply([], null, { 'X-Redbark-Truncated': 'true' });
  await assert.rejects(client.transactions('acct_A', '2026-09-01', '2026-09-01'), /single_day_truncated/);
});
test('rate limits retain Retry-After without exposing response bodies', async () => {
  const client = new RedbarkClient({
    apiKey: 'secret',
    fetchImpl: async () =>
      new Response('private bank details', {
        status: 429,
        headers: { 'Retry-After': '120' }
      })
  });
  await assert.rejects(client.accounts(), (error) => error.retryAfter === 120 && error.message === 'provider_http_429');
});
test('provider errors name the endpoint and keep only the machine-readable code and parameter', async () => {
  const rejected = (status, error) =>
    new Response(JSON.stringify({ error: { message: 'private bank detail', request_id: 'req_secret', ...error } }), {
      status
    });
  const client = new RedbarkClient({
    apiKey: 'secret',
    fetchImpl: async () => rejected(400, { type: 'invalid_request_error', code: 'parameter_invalid', param: 'from' })
  });
  await assert.rejects(client.transactions('acct_A', '2019-10-01', '2026-10-05'), (error) => {
    assert.equal(error.message, 'provider_http_400');
    assert.equal(describeRedbarkError(error), 'provider_http_400 on transactions: parameter_invalid (from)');
    return true;
  });
  client.fetch = async () => rejected(404, { code: '<b>missing</b>', param: 'account id' });
  await assert.rejects(client.balance('acct_Private1'), (error) => {
    const described = describeRedbarkError(error);
    assert.equal(described, 'provider_http_404 on balance');
    assert(!/acct_Private1|private bank detail|req_secret|<b>/.test(described));
    return true;
  });
  client.fetch = async () => new Response('not json', { status: 400 });
  await assert.rejects(client.accounts(), (error) => describeRedbarkError(error) === 'provider_http_400 on accounts');
  assert.equal(describeRedbarkError(new Error('boom')), 'sync_failed');
});
test('amount normalization is exact and fails closed on unsafe money and account mismatch', () => {
  const raw = {
    id: 'txn_fk_1',
    account: 'acct_A',
    amount: { amount: -1234, currency: 'aud' },
    date: '2026-09-01',
    description: 'Store',
    status: 'posted',
    provider_category: 'Groceries'
  };
  assert.equal(normalizeTransaction(raw, 'acct_A', '2026-09-30').amountMinor, '-1234');
  assert.equal(normalizeTransaction(raw, 'acct_A', '2026-09-30').raw, raw);
  assert.throws(() =>
    normalizeTransaction({ ...raw, amount: { amount: 9007199254740992, currency: 'aud' } }, 'acct_A')
  );
  assert.throws(() => normalizeTransaction(raw, 'acct_B'));
  assert.throws(() => boundedDates('2026-02-30', '2026-03-01'));
});
test('provider evidence distinguishes transfers, spending credits and ambiguous repayments', () => {
  const raw = {
    id: 'txn_fk_kind',
    account: 'acct_A',
    amount: { amount: -1234, currency: 'aud' },
    date: '2026-08-31',
    post_date: '2026-09-01',
    description: 'Fictional entry',
    status: 'posted'
  };
  const normalize = (patch) => normalizeTransaction({ ...raw, ...patch }, 'acct_A', '2026-09-30');
  assert.equal(normalize({ provider_category: 'TRANSFER_OUT' }).kind, 'transfer');
  assert.equal(
    normalize({
      provider_category: 'TRANSFER_IN',
      amount: { amount: 1234, currency: 'aud' }
    }).kind,
    'transfer'
  );
  assert.equal(normalize({ provider_category: 'FOOD_AND_DRINK' }).kind, 'expense');
  const refund = normalize({
    provider_category: 'FOOD_AND_DRINK',
    amount: { amount: 1234, currency: 'aud' }
  });
  assert.equal(refund.kind, 'refund');
  assert.match(refund.reviewReason, /provisional refund/);
  assert.equal(refund.date, '2026-09-01');
  assert.match(normalize({ provider_category: 'LOAN_PAYMENTS' }).reviewReason, /principal/);
  assert.equal(
    normalize({
      provider_category: 'INCOME',
      amount: { amount: 1234, currency: 'aud' }
    }).reviewReason,
    undefined
  );
  assert.match(
    normalize({
      category: 'Transfers',
      amount: { amount: 1234, currency: 'aud' }
    }).reviewReason,
    /insufficient evidence/
  );
  assert.match(normalize({ provider_category: null }).reviewReason, /insufficient evidence/);
});
