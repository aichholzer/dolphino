import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  createClientIpResolver,
  parseTrustedProxies,
  MAX_FORWARDED_FOR_LENGTH,
  MAX_FORWARDED_HOPS
} from '../src/http/client-ip.mjs';
import { createRouteRegistrar } from '../src/http/router.mjs';
import { createHouseholdAuth } from '../src/household-auth.js';
import { createApp } from '../src/app.js';

const request = (peer, forwarded, extraHeaders = {}) => ({
  socket: { remoteAddress: peer },
  headers: { ...(forwarded === undefined ? {} : { 'x-forwarded-for': forwarded }), ...extraHeaders }
});
const resolver = (value = '') => createClientIpResolver(parseTrustedProxies(value));
const digest = (value) => createHash('sha256').update(value).digest('hex');

test('TRUST_PROXY is optional, validated, bounded and immutable', () => {
  assert.deepEqual(parseTrustedProxies(), []);
  assert.deepEqual(parseTrustedProxies(' \t'), []);
  const entries = parseTrustedProxies(' 192.0.2.10, 198.51.100.0/24,2001:db8::1,2001:db8:1::/48,192.0.2.10 ');
  assert.deepEqual(entries, ['192.0.2.10', '198.51.100.0/24', '2001:db8::1', '2001:db8:1::/48']);
  assert(Object.isFrozen(entries));
  for (const invalid of [
    'true',
    '*',
    'private_ranges',
    'localhost',
    'https://192.0.2.1',
    '192.0.2.1:80',
    '[2001:db8::1]',
    'fe80::1%eth0',
    '256.0.0.1',
    '010.0.0.1',
    '192.0.2.1,',
    ',192.0.2.1',
    '192.0.2.1,,198.51.100.1',
    '192.0.2.0/33',
    '2001:db8::/129',
    '192.0.2.0/-1',
    '192.0.2.0/01',
    '192.0.2.0/1.0',
    '192.0.2.0/',
    '192.0.2.0/24/1',
    '192.0.2.0/ 24',
    'x'.repeat(4097),
    Array(65).fill('192.0.2.1').join(','),
    true,
    1,
    null
  ]) {
    assert.throws(() => parseTrustedProxies(invalid), /TRUST_PROXY/, String(invalid));
  }
  assert.throws(() => createClientIpResolver(true), /parsed IP\/CIDR list/);
  assert.throws(() => createClientIpResolver([true]), /parsed IP\/CIDR list/);
});

test('only loopback is implicitly trusted and mapped loopback has the same policy', () => {
  const resolve = resolver();
  for (const peer of ['127.0.0.1', '127.255.255.254', '::1', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1']) {
    assert.equal(resolve(request(peer, '203.0.113.9')), '203.0.113.9', peer);
  }
  for (const peer of ['10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.0.1', 'fc00::1', '2001:db8::1']) {
    assert.equal(resolve(request(peer, '203.0.113.9')), peer, peer);
  }
  assert.equal(resolve(request('::ffff:192.0.2.20', '203.0.113.9')), '192.0.2.20');
});

test('untrusted peers cannot influence the client IP through any forwarding header', () => {
  const resolve = resolver('192.0.2.10');
  const spoofed = {
    'x-real-ip': '198.51.100.1',
    forwarded: 'for=198.51.100.1',
    'cf-connecting-ip': '198.51.100.1',
    'true-client-ip': '198.51.100.1'
  };
  assert.equal(resolve(request('203.0.113.12', '198.51.100.1,192.0.2.10', spoofed)), '203.0.113.12');
  assert.equal(resolve(request('192.0.2.10', undefined, spoofed)), '192.0.2.10');
  for (const peer of [undefined, '', 'unknown', 'localhost', '192.0.2.10:80', 'fe80::1%eth0']) {
    assert.equal(resolve(request(peer, '198.51.100.1')), 'unknown');
  }
  assert.equal(resolve({ headers: { 'x-forwarded-for': '198.51.100.1' } }), 'unknown');
});

test('IPv4/IPv6 addresses and CIDR boundaries match only configured proxies', () => {
  const resolve = resolver('192.0.2.10,198.51.100.128/25,2001:db8:1234::/48,2001:db8:ffff::1');
  for (const peer of [
    '192.0.2.10',
    '::ffff:192.0.2.10',
    '198.51.100.128',
    '198.51.100.255',
    '::ffff:c633:64ff',
    '2001:DB8:1234:FFFF:FFFF:FFFF:FFFF:FFFF',
    '2001:db8:ffff::1'
  ]) {
    assert.equal(resolve(request(peer, '203.0.113.9')), '203.0.113.9', peer);
  }
  for (const peer of ['192.0.2.11', '198.51.100.127', '198.51.101.0', '2001:db8:1235::', '2001:db8:ffff::2']) {
    assert.equal(resolve(request(peer, '203.0.113.9')), peer, peer);
  }
  assert.equal(resolver('::ffff:192.0.2.0/120')(request('192.0.2.10', '203.0.113.9')), '203.0.113.9');
  assert.equal(resolver('::ffff:192.0.2.10')(request('192.0.2.10', '203.0.113.9')), '203.0.113.9');
});

test('chains are walked right to left and stop at the first unknown proxy hop', () => {
  const caddyOnly = resolver('192.0.2.10');
  const allProxies = resolver('192.0.2.10,198.51.100.0/24,2001:db8:1234::/48');
  const chain = '203.0.113.66,203.0.113.9,2001:db8:1234::10,198.51.100.20';
  assert.equal(caddyOnly(request('192.0.2.10', chain)), '198.51.100.20');
  assert.equal(allProxies(request('192.0.2.10', chain)), '203.0.113.9');
  assert.equal(allProxies(request('192.0.2.10', '203.0.113.66,203.0.113.9')), '203.0.113.9');
  assert.equal(allProxies(request('192.0.2.10', '\t203.0.113.9 \t, 198.51.100.20\t')), '203.0.113.9');
  assert.equal(allProxies(request('192.0.2.10', '198.51.100.20')), '198.51.100.20');
  assert.equal(allProxies(request('192.0.2.10', '203.0.113.9')), '203.0.113.9');
});

test('malformed, empty and non-string chains fall back to the immediate peer in full', () => {
  const resolve = resolver('192.0.2.10,198.51.100.0/24');
  for (const header of [
    '',
    ' ',
    ',',
    ',203.0.113.9',
    '203.0.113.9,',
    '203.0.113.9,,198.51.100.20',
    'unknown,203.0.113.9,198.51.100.20',
    '203.0.113.9,unknown,198.51.100.20',
    '203.0.113.9,unknown',
    'for=203.0.113.9',
    '"203.0.113.9"',
    '203.0.113.9:80',
    '[2001:db8::1]',
    '[2001:db8::1]:80',
    '203.0.113.9/32',
    'fe80::1%eth0',
    '203.0.113.9\r\n',
    '\u00a0203.0.113.9',
    '203.0.113.9\u0000',
    ['203.0.113.9'],
    42,
    null
  ]) {
    assert.equal(resolve(request('192.0.2.10', header)), '192.0.2.10', JSON.stringify(header));
  }
});

test('forwarded headers have hard byte and hop limits without truncation', () => {
  const resolve = resolver('192.0.2.10,198.51.100.0/24');
  const atLimit = '203.0.113.9'.padEnd(MAX_FORWARDED_FOR_LENGTH, ' ');
  assert.equal(resolve(request('192.0.2.10', atLimit)), '203.0.113.9');
  assert.equal(resolve(request('192.0.2.10', `${atLimit} `)), '192.0.2.10');
  assert.equal(resolve(request('192.0.2.10', 'é'.repeat(MAX_FORWARDED_FOR_LENGTH))), '192.0.2.10');
  const hops = ['203.0.113.9', ...Array(MAX_FORWARDED_HOPS - 1).fill('198.51.100.20')];
  assert.equal(resolve(request('192.0.2.10', hops.join(','))), '203.0.113.9');
  assert.equal(resolve(request('192.0.2.10', [...hops, '198.51.100.20'].join(','))), '192.0.2.10');
});

test('equivalent IPv6 and mapped IPv4 addresses resolve to stable client keys', () => {
  const resolve = resolver();
  assert.equal(resolve(request('2001:0DB8:0000:0000:0000:0000:0000:0001')), '2001:db8::1');
  for (const address of ['192.0.2.4', '::ffff:192.0.2.4', '0:0:0:0:0:ffff:c000:0204']) {
    assert.equal(resolve(request('127.0.0.1', address)), '192.0.2.4');
  }
});

function rateFixture(trustProxy) {
  const attempts = new Map();
  const pool = {
    query: async (sql, params) => {
      if (sql.startsWith('DELETE')) {
        return { rows: [] };
      }
      const key = params[0];
      attempts.set(key, (attempts.get(key) || 0) + 1);
      return { rows: [{ attempts: attempts.get(key) }] };
    }
  };
  return { auth: createHouseholdAuth({ pool, config: { mode: 'live', trustProxy } }), attempts };
}

test('authentication limits use resolved client IPs and cannot be bypassed with spoofed headers', async () => {
  const { auth, attempts } = rateFixture(parseTrustedProxies('192.0.2.10'));
  for (let index = 0; index < 10; index++) {
    const req = request('203.0.113.9', `198.51.100.${index}`);
    req.clientIp = 'forged-property';
    await auth.rate(req, 'login');
    assert.equal(req.clientIp, '203.0.113.9');
  }
  await assert.rejects(auth.rate(request('203.0.113.9', '198.51.100.200'), 'login'), { status: 429 });
  assert.equal(attempts.get(digest('login:203.0.113.9')), 11);
  await auth.rate(request('192.0.2.10', '203.0.113.10'), 'login');
  await auth.rate(request('192.0.2.10', '203.0.113.11'), 'login');
  assert.equal(attempts.get(digest('login:203.0.113.10')), 1);
  assert.equal(attempts.get(digest('login:203.0.113.11')), 1);
  await auth.rate(request('192.0.2.10', '203.0.113.9,unknown'), 'login');
  assert.equal(attempts.get(digest('login:192.0.2.10')), 1);
  await auth.rate(request('203.0.113.9'), 'activation');
  assert.equal(attempts.get(digest('activation:203.0.113.9')), 1);
});

test('authentication limits normalize IPv6 and IPv4-mapped spellings', async () => {
  const { auth, attempts } = rateFixture();
  for (const client of ['192.0.2.4', '::ffff:192.0.2.4', '::FFFF:C000:0204']) {
    await auth.rate(request('127.0.0.1', client), 'login');
  }
  assert.equal(attempts.get(digest('login:192.0.2.4')), 3);
  for (const client of ['2001:db8::1', '2001:0DB8:0:0:0:0:0:1']) {
    await auth.rate(request('127.0.0.1', client), 'login');
  }
  assert.equal(attempts.get(digest('login:2001:db8::1')), 2);
});

test('shared HTTP boundary exposes the same client IP before authentication and to handlers', async () => {
  const observed = [];
  let handle;
  const { auth, attempts } = rateFixture(parseTrustedProxies('192.0.2.10'));
  const route = createRouteRegistrar({
    app: { get: (_path, handler) => (handle = handler) },
    config: { trustProxy: parseTrustedProxies('192.0.2.10') },
    securityHeaders: () => {},
    auth: {
      session: async (req) => {
        observed.push(req.clientIp);
        return { id: 'synthetic-user', role: 'member' };
      }
    }
  });
  route(
    'get',
    '/probe',
    async (req) => {
      observed.push(req.clientIp);
      await auth.rate(req, 'login');
      observed.push(req.clientIp);
      return { ok: true };
    },
    { access: 'member' }
  );
  const req = { ...request('192.0.2.10', '198.51.100.66,203.0.113.9'), method: 'GET', url: '/probe' };
  await new Promise((resolve, reject) => {
    handle(req, {
      setHeader: () => {},
      writeHead: () => {},
      end: (body) => {
        try {
          assert.deepEqual(JSON.parse(body), { ok: true });
          resolve();
        } catch (error) {
          reject(error);
        }
      }
    });
  });
  assert.deepEqual(observed, ['203.0.113.9', '203.0.113.9', '203.0.113.9']);
  assert.equal(attempts.get(digest('login:203.0.113.9')), 1);
});

test('actual HTTP requests resolve forwarding headers before public authentication handlers', async (t) => {
  const observed = [];
  const config = { mode: 'live', host: '127.0.0.1', port: 0, origin: 'https://dolphino.test' };
  const app = createApp({
    config,
    store: { pool: {} },
    auth: {
      login: async (req) => {
        observed.push(req.clientIp);
        return { cookie: 'synthetic=test', user: { id: 'synthetic-user' } };
      }
    }
  });
  const server = await new Promise((resolve) => {
    const server = app.start(() => resolve(server));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  for (const forwarded of ['198.51.100.66,203.0.113.9', 'unknown,203.0.113.9', '::FFFF:C000:0204']) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/login`, {
      method: 'POST',
      headers: { Origin: config.origin, 'X-Forwarded-For': forwarded },
      body: JSON.stringify({ email: 'synthetic@example.test', password: 'synthetic-only' })
    });
    assert.equal(response.status, 200);
    await response.json();
  }
  assert.deepEqual(observed, ['203.0.113.9', '127.0.0.1', '192.0.2.4']);
});
