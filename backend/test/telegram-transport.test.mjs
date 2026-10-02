import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:https';
import { createServer as createProxy } from 'node:http';
import { connect } from 'node:net';
import { telegramTransportCode } from '../src/lib/telegram-errors.mjs';

let directory;
const certificates = {};
before(() => {
  directory = mkdtempSync(join(tmpdir(), 'dolphino-telegram-tls-'));
  for (const [name, hostname] of [
    ['matching', 'api.telegram.org'],
    ['wrong-host', 'wrong.example.test']
  ]) {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:prime256v1',
        '-nodes',
        '-sha256',
        '-keyout',
        `${name}.key`,
        '-out',
        `${name}.pem`,
        '-days',
        '2',
        '-subj',
        `/CN=${hostname}`,
        '-addext',
        `subjectAltName=DNS:${hostname}`
      ],
      { cwd: directory, stdio: 'pipe', timeout: 10000 }
    );
    certificates[name] = {
      key: readFileSync(join(directory, `${name}.key`)),
      cert: readFileSync(join(directory, `${name}.pem`))
    };
  }
});
after(() => rmSync(directory, { recursive: true, force: true }));

async function fixture(t, { certificate = 'matching', behavior = 'ok' } = {}) {
  const requests = [];
  const server = createServer(certificates[certificate], (request, response) => {
    requests.push({ method: request.method, path: request.url, servername: request.socket.servername });
    if (behavior === 'headers-timeout') {
      return;
    }

    if (behavior === 'reset') {
      request.socket.destroy();
      return;
    }

    if (behavior === 'redirect') {
      response.writeHead(302, { Location: '/must-not-follow' });
      response.end();
      return;
    }

    response.writeHead(200, { 'Content-Type': 'application/json' });
    if (behavior === 'body-timeout') {
      response.write('{"ok":true,');
      return;
    }

    response.end(JSON.stringify({ ok: true, result: { is_bot: true, username: 'syntheticSocketBot' } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { server, port: server.address().port, requests, certificate };
}

async function run(f, values = {}, { trusted = true, proxyEnv = {}, nodeArgs = [] } = {}) {
  const { stdout, stderr } = await promisify(execFile)(
    process.execPath,
    [
      ...nodeArgs,
      fileURLToPath(new URL('./helpers/telegram-tls-client.mjs', import.meta.url)),
      JSON.stringify({ port: f.port, ...values })
    ],
    {
      timeout: 20000,
      maxBuffer: 32768,
      // Never inherit real proxy credentials, NODE_OPTIONS or TLS bypasses.
      env: {
        PATH: process.env.PATH,
        ...(trusted ? { NODE_EXTRA_CA_CERTS: join(directory, `${f.certificate}.pem`) } : {}),
        ...proxyEnv
      }
    }
  );
  assert.equal(stderr, '');
  return JSON.parse(stdout);
}

test('Telegram real Node fetch sends getMe over verified TLS with matching SNI and Node 24 all-address DNS', async (t) => {
  const f = await fixture(t);
  for (const dualStack of [false, true]) {
    const result = await run(f, { dualStack });
    assert.deepEqual(result.result, { is_bot: true, username: 'syntheticSocketBot' });
    assert.deepEqual(result.causes, []);
    assert.ok(result.lookups.some((lookup) => lookup.all === true));
    assert.deepEqual(result.dials, [
      {
        autoSelectFamily: true,
        attemptTimeout: 2000,
        rejectUnauthorized: true,
        servername: 'api.telegram.org'
      }
    ]);
  }

  assert.equal(f.requests.length, 2);
  assert.ok(
    f.requests.every((r) => r.method === 'POST' && r.path.endsWith('/getMe') && r.servername === 'api.telegram.org')
  );
});

test('Telegram gives actual TLS sockets 2000 ms per address without changing unrelated fetch or net defaults', async (t) => {
  const f = await fixture(t);
  const result = await run(f, { alsoUnscoped: true });
  assert.ok(result.result.is_bot);
  assert.equal(result.defaultAttemptTimeout, 250);
  assert.equal(result.dials.length, 2);
  assert.equal(result.dials[0].attemptTimeout, 2000);
  assert.equal(result.dials[1].attemptTimeout, undefined);
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[1].path, '/unrelated-fetch');
});

test('Telegram built-in fetch uses an environment proxy only when Node proxy support is enabled', async (t) => {
  const f = await fixture(t);
  let tunnels = 0;
  const sockets = new Set();
  const proxy = createProxy();
  proxy.on('connect', (request, client, head) => {
    assert.equal(request.url, `api.telegram.org:${f.port}`);
    tunnels++;
    const upstream = connect(f.port, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) {
        upstream.write(head);
      }

      client.pipe(upstream);
      upstream.pipe(client);
    });
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on('error', () => {
        client.destroy();
        upstream.destroy();
      });
      socket.on('close', () => sockets.delete(socket));
    }
  });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of sockets) {
      socket.destroy();
    }

    await new Promise((resolve) => proxy.close(resolve));
  });
  const proxyEnv = { HTTPS_PROXY: `http://127.0.0.1:${proxy.address().port}` };
  assert.ok((await run(f, {}, { proxyEnv })).result?.is_bot);
  assert.equal(tunnels, 0, 'HTTPS_PROXY alone does not change the default Node fetch path');
  for (const options of [
    { proxyEnv: { ...proxyEnv, NODE_USE_ENV_PROXY: '1' } },
    { proxyEnv: { ...proxyEnv, NODE_OPTIONS: '"--use-env-proxy"' } },
    { proxyEnv, nodeArgs: ['--use-env-proxy'] }
  ]) {
    const result = await run(f, {}, options);
    assert.ok(result.result?.is_bot);
    assert.equal(result.dials[0].attemptTimeout, 2000);
    assert.equal(result.dials[0].rejectUnauthorized, true);
  }

  assert.equal(tunnels, 3);
  assert.ok(
    (await run(f, {}, { proxyEnv: { ...proxyEnv, NODE_USE_ENV_PROXY: '1', NO_PROXY: 'api.telegram.org' } })).result
      ?.is_bot
  );
  assert.equal(tunnels, 3, 'NO_PROXY still bypasses a configured proxy');
  const untrusted = await run(f, {}, { trusted: false, proxyEnv: { ...proxyEnv, NODE_USE_ENV_PROXY: '1' } });
  assert.equal(untrusted.code, 'telegram_tls_failed');
  assert.equal(tunnels, 4, 'proxy tunneling never bypasses certificate verification');
  assert.equal(f.requests.length, 5);
});

test('Telegram real Node fetch classifies refused dual-stack sockets without retaining addresses', async (t) => {
  const f = await fixture(t);
  await new Promise((resolve) => f.server.close(resolve));
  const result = await run(f, { dualStack: true });
  assert.equal(result.code, 'telegram_connection_refused');
  assert.ok(result.causes.some((cause) => cause.code === 'ECONNREFUSED'));
  assert.equal(result.causeRetained, false);
  assert.ok(!result.serialized.includes('127.0.0.1'));
  assert.equal(f.requests.length, 0);
});

test('Telegram real Node fetch rejects untrusted certificates and trusted certificates for the wrong hostname', async (t) => {
  const untrusted = await fixture(t);
  const wrongHost = await fixture(t, { certificate: 'wrong-host' });
  for (const [f, options, expected] of [
    [untrusted, { trusted: false }, 'DEPTH_ZERO_SELF_SIGNED_CERT'],
    [wrongHost, {}, 'ERR_TLS_CERT_ALTNAME_INVALID']
  ]) {
    const result = await run(f, {}, options);
    assert.equal(result.code, 'telegram_tls_failed');
    assert.ok(
      result.causes.some((cause) => cause.code === expected),
      JSON.stringify(result.causes)
    );
    assert.equal(result.causeRetained, false);
    assert.equal(f.requests.length, 0);
  }
});

test('Telegram real Node fetch preserves DNS failure evidence only as safe local error codes', async (t) => {
  const f = await fixture(t);
  const result = await run(f, { dnsFailure: true });
  assert.equal(result.code, 'telegram_dns_failed');
  assert.ok(result.causes.some((cause) => cause.code === 'ENOTFOUND'));
  assert.equal(result.causeRetained, false);
  assert.equal(f.requests.length, 0);
});

test('Telegram real Node fetch never follows a redirect carrying a bot token', async (t) => {
  const f = await fixture(t, { behavior: 'redirect' });
  const result = await run(f);
  assert.equal(result.code, 'telegram_unreachable');
  assert.equal(f.requests.length, 1);
  assert.ok(!f.requests.some((r) => r.path === '/must-not-follow'));
});

test('Telegram real Node fetch socket reset and stalled response bodies remain credential-safe', async (t) => {
  for (const [behavior, expected, rawCode] of [
    ['reset', 'telegram_connection_closed', 'UND_ERR_SOCKET'],
    ['body-timeout', 'telegram_timeout', undefined]
  ]) {
    const f = await fixture(t, { behavior });
    const result = await run(f, { fastAbort: behavior === 'body-timeout' });
    assert.equal(result.code, expected);
    assert.ok(result.causes.some((cause) => (rawCode ? cause.code === rawCode : cause.name === 'TimeoutError')));
    assert.equal(result.causeRetained, false);
    assert.equal(f.requests.length, 1);
  }
});

test(
  'Telegram real Node fetch enforces its production twelve-second deadline before response headers',
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t, { behavior: 'headers-timeout' });
    const started = Date.now();
    const result = await run(f);
    assert.equal(result.code, 'telegram_timeout');
    assert.ok(result.causes.some((cause) => cause.name === 'TimeoutError'));
    assert.ok(Date.now() - started >= 11000);
    assert.equal(f.requests.length, 1);
  }
);

test('Telegram transport diagnostics classify bounded nested causes without reflecting private text', () => {
  const privateText = 'https://api.telegram.org/bot123456789:synthetic_secret_token/getMe';
  for (const [code, expected] of [
    ['EAI_AGAIN', 'dns_failed'],
    ['ECONNREFUSED', 'connection_refused'],
    ['EHOSTUNREACH', 'network_unreachable'],
    ['ENETUNREACH', 'network_unreachable'],
    ['UND_ERR_CONNECT_TIMEOUT', 'timeout'],
    ['CERT_HAS_EXPIRED', 'tls_failed'],
    ['UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'tls_failed'],
    ['ECONNRESET', 'connection_closed']
  ]) {
    const error = new TypeError(privateText, {
      cause: new AggregateError([Object.assign(new Error(privateText), { code })])
    });
    assert.equal(telegramTransportCode(error), `telegram_${expected}`);
  }

  const mixed = new AggregateError([{ code: 'ENETUNREACH' }, { code: 'ETIMEDOUT' }]);
  assert.equal(telegramTransportCode(new TypeError(privateText, { cause: mixed })), 'telegram_timeout');
  const cycle = { message: privateText, code: privateText };
  cycle.cause = cycle;
  cycle.errors = [cycle];
  assert.equal(telegramTransportCode(cycle), 'telegram_unreachable');
  assert.equal(
    telegramTransportCode(new SyntaxError(privateText), 'telegram_response_invalid'),
    'telegram_response_invalid'
  );
});
