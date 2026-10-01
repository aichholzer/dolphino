import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  parseSetupToken,
  parseSimplefinUrl,
  secureSimplefinRequest,
  claimSetupToken,
  SimplefinClient,
  simplefinMoney,
  normalizeSimplefinTransaction,
  simplefinAccountKey
} from '../src/simplefin-client.js';
const claim = 'https://provider.example.com/simplefin/claim/one-time';
const token = Buffer.from(claim).toString('base64');
const access = 'https://synthetic-user:synthetic-secret@provider.example.com/simplefin';
const account = {
  id: 'bank-1',
  name: 'Fictional bank',
  org: { domain: 'bank.example.com' },
  currency: 'AUD',
  balance: '123.40',
  'balance-date': 1760000000,
  transactions: []
};
function transport(response = { status: 200, body: 'ok', headers: {} }) {
  const calls = [];
  return {
    calls,
    requestImpl(options, callback) {
      calls.push(options);
      const req = new EventEmitter();
      req.destroy = () => {};
      req.end = () =>
        queueMicrotask(() => {
          const res = new PassThrough();
          res.statusCode = response.status;
          res.headers = response.headers;
          callback(res);
          res.end(response.body);
        });
      return req;
    }
  };
}
test('SimpleFIN setup tokens are canonical and URL parsing fails closed', () => {
  assert.equal(parseSetupToken(token).href, claim);
  assert.equal(parseSetupToken(Buffer.from(claim).toString('base64url')).href, claim);
  for (const value of [
    token + '=',
    token + '!',
    token + '\n',
    'a===',
    'abcd',
    Buffer.from('http://provider.example.com/claim/x').toString('base64'),
    Buffer.from('https://u:p@provider.example.com/claim/x').toString('base64'),
    Buffer.from('https://provider.example.com/arbitrary-write').toString('base64')
  ]) {
    assert.throws(() => parseSetupToken(value));
  }
  for (const url of [
    'https://127.0.0.1/a',
    'https://[::1]/a',
    'https://0x7f000001/a',
    'https://2130706433/a',
    'https://foo.local/a',
    'https://a.internal/a',
    'https://localhost/a',
    'https://provider.example.com:444/a',
    'https://provider.example.com/a?x=1',
    'https://provider.example.com/a#x',
    'https://provider.example.com./a',
    'https://provider.example.com\\@localhost/a'
  ]) {
    assert.throws(() => parseSimplefinUrl(url));
  }
  assert.throws(() => parseSimplefinUrl('https://u%3Av:p@provider.example.com/simplefin', true));
});
test('SimpleFIN transport rejects all non-public and mixed DNS answers before dialing', async () => {
  for (const address of [
    '0.0.0.0',
    '10.1.2.3',
    '100.64.1.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.2.3',
    '192.168.1.1',
    '192.0.2.4',
    '198.18.0.1',
    '224.0.0.1',
    '::1',
    '::ffff:8.8.8.8',
    '64:ff9b::808:808',
    '2002:0808:0808::1',
    '2001::1',
    '2001:db8::1',
    'fe80::1',
    'fc00::1'
  ]) {
    let calls = 0;
    await assert.rejects(
      secureSimplefinRequest(new URL(claim), {
        lookupImpl: async () => [{ address, family: address.includes(':') ? 6 : 4 }],
        requestImpl: () => {
          calls++;
        }
      }),
      /non_public/
    );
    assert.equal(calls, 0);
  }
  await assert.rejects(
    secureSimplefinRequest(new URL(claim), {
      lookupImpl: async () => [
        { address: '8.8.8.8', family: 4 },
        { address: '10.0.0.1', family: 4 }
      ]
    }),
    /non_public/
  );
});
test('SimpleFIN pins public DNS, keeps TLS hostname and rejects redirects, bounds bodies and time', async () => {
  let lookups = 0;
  const t = transport();
  assert.equal(
    (
      await secureSimplefinRequest(new URL(claim), {
        lookupImpl: async () => {
          lookups++;
          return [{ address: lookups === 1 ? '8.8.8.8' : '127.0.0.1', family: 4 }];
        },
        requestImpl: t.requestImpl
      })
    ).body,
    'ok'
  );
  assert.equal(lookups, 1);
  const opts = t.calls[0];
  assert.equal(opts.servername, 'provider.example.com');
  assert.equal(opts.rejectUnauthorized, true);
  assert.equal(opts.agent, false);
  opts.lookup('provider.example.com', {}, (_e, address) => assert.equal(address, '8.8.8.8'));
  assert.equal(lookups, 1);
  const dns = async () => [{ address: '8.8.8.8', family: 4 }];
  for (const status of [301, 302, 303, 307, 308]) {
    const r = transport({
      status,
      body: 'secret',
      headers: { location: 'http://127.0.0.1/private' }
    });
    await assert.rejects(
      secureSimplefinRequest(new URL(claim), {
        lookupImpl: dns,
        requestImpl: r.requestImpl
      }),
      /redirect/
    );
    assert.equal(r.calls.length, 1);
  }
  await assert.rejects(
    secureSimplefinRequest(new URL(claim), {
      lookupImpl: dns,
      requestImpl: transport({ status: 200, body: 'abcdef', headers: {} }).requestImpl,
      maxBytes: 3
    }),
    /too_large/
  );
  await assert.rejects(
    secureSimplefinRequest(new URL(claim), {
      lookupImpl: () => new Promise(() => {}),
      timeoutMs: 5
    }),
    /dns_unavailable/
  );
  let destroyed = false;
  await assert.rejects(
    secureSimplefinRequest(new URL(claim), {
      lookupImpl: dns,
      timeoutMs: 5,
      requestImpl: () => {
        const req = new EventEmitter();
        req.end = () => {};
        req.destroy = () => {
          destroyed = true;
        };
        return req;
      }
    }),
    /timeout/
  );
  assert(destroyed);
});
test('SimpleFIN claims once and never forwards auth across origins', async () => {
  let calls = 0;
  assert.equal(
    await claimSetupToken(token, {
      request: async (url, options) => {
        calls++;
        assert.equal(url.href, claim);
        assert.equal(options.method, 'POST');
        assert.equal(options.authorization, undefined);
        return { status: 200, body: access };
      }
    }),
    access
  );
  assert.equal(calls, 1);
  for (const response of [
    { status: 403, body: 'secret' },
    { status: 200, body: 'https://u:p@other.example.com/simplefin' },
    { status: 200, body: 'https://u:p@provider.example.com/other' }
  ]) {
    await assert.rejects(
      claimSetupToken(token, {
        request: async () => {
          calls++;
          return response;
        }
      })
    );
  }
  const parsed = parseSimplefinUrl(access, true);
  assert.equal(parsed.url.href, 'https://provider.example.com/simplefin');
  assert.match(parsed.authorization, /^Basic /);
  assert(!parsed.url.href.includes('synthetic-secret'));
});
test('SimpleFIN exact ISO money, dates, stable scoped IDs and pending remain explicit', () => {
  assert.equal(simplefinMoney('-90071992547409.91', 'AUD'), '-9007199254740991');
  assert.equal(simplefinMoney('12.000', 'JPY'), '12');
  assert.equal(simplefinMoney('1.234', 'KWD'), '1234');
  for (const [a, c] of [
    [1.2, 'AUD'],
    ['1.001', 'AUD'],
    ['1e2', 'AUD'],
    ['1.0', 'ZZZ'],
    ['1.0', 'https://currency.example.com/points'],
    ['9223372036854775808', 'JPY']
  ]) {
    assert.throws(() => simplefinMoney(a, c));
  }
  const raw = {
    id: 'same',
    posted: 1760000000,
    amount: '-1.23',
    description: 'Fictional'
  };
  const options = {
    provider: 'simplefin:one',
    fetchedAt: '2026-10-01T00:00:00Z',
    timezone: 'Australia/Brisbane'
  };
  const tx = normalizeSimplefinTransaction(raw, { localId: 'sfin_a', currency: 'AUD' }, options);
  assert.equal(tx.amountMinor, '-123');
  assert.equal(tx.status, 'posted');
  assert.equal(tx.provider, 'simplefin:one');
  assert.equal(
    normalizeSimplefinTransaction(
      { ...raw, pending: true, posted: 0, transacted_at: 1760000000 },
      { localId: 'sfin_a', currency: 'AUD' },
      options
    ).status,
    'pending'
  );
  assert.throws(() =>
    normalizeSimplefinTransaction({ ...raw, pending: true, posted: 0 }, { localId: 'sfin_a', currency: 'AUD' }, options)
  );
  assert.notEqual(
    simplefinAccountKey(account),
    simplefinAccountKey({
      ...account,
      org: { domain: 'different.example.com' }
    })
  );
});
test('SimpleFIN generic v1 providers normalize metadata, redact errors and handle rate limits', async () => {
  const request = async (url, opts) => {
    assert.equal(url.origin, 'https://provider.example.com');
    assert.equal(url.searchParams.get('pending'), null);
    assert.equal(url.searchParams.get('start-date'), '10');
    assert.match(opts.authorization, /^Basic /);
    return {
      status: 200,
      body: JSON.stringify({
        accounts: [account],
        errors: ['<b>Reconnect</b> synthetic-secret https://u:p@host.example.com/path']
      })
    };
  };
  const result = await new SimplefinClient(access, { request }).accounts({
    start: 10,
    end: 20
  });
  assert.equal(result.accounts[0].balanceMinor, '12340');
  assert.equal(result.errors[0], 'Reconnect [redacted] [link removed]');
  await assert.rejects(
    new SimplefinClient(access, {
      request: async () => ({
        status: 429,
        headers: { 'retry-after': '600' },
        body: ''
      })
    }).accounts(),
    (e) => e.retryAfter === 600
  );
  await assert.rejects(
    new SimplefinClient(access, {
      request: async () => ({
        status: 200,
        body: JSON.stringify({ accounts: [account, account], errors: [] })
      })
    }).accounts(),
    /duplicate_account/
  );
  const unsupported = await new SimplefinClient(access, {
    request: async () => ({
      status: 200,
      body: JSON.stringify({
        accounts: [{ ...account, currency: 'https://points.example.com/miles' }],
        errors: []
      })
    })
  }).accounts();
  assert.equal(unsupported.accounts[0].unsupported, true);
  await assert.rejects(
    new SimplefinClient(access, {
      request: async () => ({
        status: 200,
        body: JSON.stringify({ accounts: [], errlist: [] })
      })
    }).accounts(),
    /invalid_response/
  );
});

test('SimpleFIN honors Retry-After beyond one day and fails closed on unrepresentable delays', async () => {
  await assert.rejects(
    new SimplefinClient(access, {
      request: async () => ({
        status: 429,
        headers: { 'retry-after': '172800' },
        body: ''
      })
    }).accounts(),
    (e) => e.retryAfter === 172800
  );
  await assert.rejects(
    new SimplefinClient(access, {
      request: async () => ({
        status: 429,
        headers: { 'retry-after': '9'.repeat(400) },
        body: ''
      })
    }).accounts(),
    /retry_after_out_of_range/
  );
});
