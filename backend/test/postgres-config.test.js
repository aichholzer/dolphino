import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { createSecureContext, getCACertificates, TLSSocket } from 'node:tls';
import pg from 'pg';
import { readPostgresConfig } from '../src/postgres-config.js';

// These tests never consult a real database or the process's database settings.
// Synthetic keys exist only in this temporary directory and are removed afterward.
const baseEnv = {
  PGHOST: '127.0.0.1',
  PGDATABASE: 'synthetic_database',
  PGUSER: 'synthetic_user',
  PGPASSWORD: 'synthetic_password'
};
let directory;
let caPath;
let certificates;

function writeFixture(name, contents) {
  const path = join(directory, name);
  writeFileSync(path, contents, { mode: 0o600 });
  return path;
}

function openssl(...args) {
  execFileSync('openssl', args, { cwd: directory, stdio: 'pipe', timeout: 10000 });
}

before(() => {
  directory = mkdtempSync(join(tmpdir(), 'dolphino-postgres-tls-'));
  caPath = join(directory, 'ca.pem');
  openssl(
    'req',
    '-x509',
    '-newkey',
    'ec',
    '-pkeyopt',
    'ec_paramgen_curve:prime256v1',
    '-nodes',
    '-sha256',
    '-keyout',
    'ca.key',
    '-out',
    'ca.pem',
    '-days',
    '2',
    '-subj',
    '/CN=Dolphino synthetic PostgreSQL test CA',
    '-addext',
    'basicConstraints=critical,CA:TRUE',
    '-addext',
    'keyUsage=critical,keyCertSign,cRLSign'
  );
  writeFixture('index.txt', '');
  writeFixture('serial', '1000\n');
  writeFixture(
    'ca.cnf',
    [
      '[ca]',
      'default_ca=synthetic',
      '[synthetic]',
      'database=index.txt',
      'serial=serial',
      'new_certs_dir=.',
      'certificate=ca.pem',
      'private_key=ca.key',
      'default_md=sha256',
      'default_days=2',
      'policy=synthetic_policy',
      'unique_subject=no',
      '[synthetic_policy]',
      'commonName=supplied',
      ''
    ].join('\n')
  );
  certificates = {};
  for (const [name, subject, san] of [
    ['matching', 'localhost', 'DNS:localhost,IP:127.0.0.1,IP:::1'],
    ['wrong-host', 'wrong.example.test', 'DNS:wrong.example.test'],
    // A DNS SAN for localhost must never authenticate an IP-only connection.
    ['dns-only', '127.0.0.1', 'DNS:localhost'],
    ['expired', 'localhost', 'DNS:localhost,IP:127.0.0.1']
  ]) {
    openssl(
      'req',
      '-new',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-keyout',
      `${name}.key`,
      '-out',
      `${name}.csr`,
      '-subj',
      `/CN=${subject}`
    );
    writeFixture(
      `${name}.ext`,
      [
        'basicConstraints=critical,CA:FALSE',
        'keyUsage=critical,digitalSignature',
        'extendedKeyUsage=serverAuth',
        `subjectAltName=${san}`,
        ''
      ].join('\n')
    );
    openssl(
      'ca',
      '-batch',
      '-notext',
      '-config',
      'ca.cnf',
      '-in',
      `${name}.csr`,
      '-out',
      `${name}.pem`,
      '-extfile',
      `${name}.ext`,
      ...(name === 'expired' ? ['-startdate', '20000101000000Z', '-enddate', '20010101000000Z'] : [])
    );
    certificates[name] = {
      key: readFileSync(join(directory, `${name}.key`)),
      cert: readFileSync(join(directory, `${name}.pem`))
    };
  }
});

after(() => {
  if (directory) {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('PostgreSQL options are explicit, preserve credentials, and default only the TCP port', () => {
  assert.deepEqual(readPostgresConfig(baseEnv), {
    host: '127.0.0.1',
    port: 5432,
    database: 'synthetic_database',
    user: 'synthetic_user',
    password: 'synthetic_password',
    ssl: false
  });
  for (const password of [' leading and trailing ', '  ', 'line one\nline two\n', 'colon:@/?#%+']) {
    const config = readPostgresConfig({ ...baseEnv, PGPASSWORD: password });
    assert.equal(config.password, password);
    assert.equal('connectionString' in config, false);
  }
});

test('missing required PostgreSQL fields fail rather than falling back to process or pg defaults', () => {
  for (const field of ['PGHOST', 'PGDATABASE', 'PGUSER', 'PGPASSWORD']) {
    for (const value of [undefined, '']) {
      assert.throws(() => readPostgresConfig({ ...baseEnv, [field]: value }), new RegExp(field));
    }
  }
  assert.throws(() => readPostgresConfig({}), /PGHOST/);
});

test('PGPORT accepts only integer TCP ports in range', () => {
  for (const port of ['1', '5432', '65535']) {
    assert.equal(readPostgresConfig({ ...baseEnv, PGPORT: port }).port, Number(port));
  }
  for (const port of ['0', '65536', '-1', '1.5', '5432abc', '1e3', '0x1538', ' 5432', '5432 ', ' ']) {
    assert.throws(() => readPostgresConfig({ ...baseEnv, PGPORT: port }), /PGPORT/, port);
  }
});

test('PGHOST accepts a single DNS hostname or raw IP and rejects URLs, ports, lists and sockets', () => {
  for (const host of ['db', 'db.example.test', 'db-1.example.test', '192.0.2.2', '2001:db8::2']) {
    assert.equal(readPostgresConfig({ ...baseEnv, PGHOST: host, PGSSLMODE: 'disable' }).host, host);
  }
  for (const host of [
    'postgres://db/example',
    'postgresql://user:password@db/example',
    'db:5432',
    'db,other',
    'db other',
    '/var/run/postgresql',
    '[::1]',
    'fe80::1%eth0',
    'db/path',
    'user@db',
    'db?sslmode=disable',
    'db#fragment',
    'db..example',
    '-db.example',
    'db-.example',
    `${'a'.repeat(64)}.example`,
    'db\nother'
  ]) {
    assert.throws(() => readPostgresConfig({ ...baseEnv, PGHOST: host, PGSSLMODE: 'disable' }), /PGHOST/, host);
  }
});

test('only loopback literals and localhost get implicit plaintext mode', () => {
  for (const host of [
    'localhost',
    'LOCALHOST',
    '127.0.0.1',
    '127.12.34.56',
    '::1',
    '0:0:0:0:0:0:0:1',
    '::ffff:127.0.0.1'
  ]) {
    assert.equal(readPostgresConfig({ ...baseEnv, PGHOST: host }).ssl, false, host);
  }
  for (const host of [
    'postgres',
    'db.example.test',
    'localhost.example.test',
    '10.0.0.2',
    '192.168.1.2',
    '0.0.0.0',
    '::',
    '2001:db8::1'
  ]) {
    assert.throws(() => readPostgresConfig({ ...baseEnv, PGHOST: host }), /PGSSLMODE/, host);
  }
});

test('only disable, require and verify-full are supported, with no implicit fallback modes', () => {
  for (const mode of ['allow', 'prefer', 'verify-ca', 'no-verify', 'true', 'false', 'REQUIRE', ' verify-full ']) {
    assert.throws(() => readPostgresConfig({ ...baseEnv, PGSSLMODE: mode }), /PGSSLMODE/, mode);
  }
  const warnings = [];
  assert.equal(
    readPostgresConfig(
      { ...baseEnv, PGHOST: 'remote.example.test', PGSSLMODE: 'disable' },
      {
        warn: (...args) => warnings.push(args)
      }
    ).ssl,
    false
  );
  assert.equal(warnings.length, 0);
});

test('require explicitly warns that encryption does not authenticate the server', () => {
  const warnings = [];
  const config = readPostgresConfig(
    { ...baseEnv, PGSSLMODE: 'require' },
    {
      warn: (...args) => warnings.push(args)
    }
  );
  assert.deepEqual(config.ssl, { rejectUnauthorized: false, minVersion: 'TLSv1.2' });
  assert.equal(warnings.length, 1);
  const warning = String(warnings[0][0]);
  assert.match(warning, /PGSSLMODE=require/);
  assert.match(warning, /encrypt/i);
  assert.match(warning, /(?:not|without|no).*authenticat|unverified|not.*verif/i);
  assert.match(warning, /verify-full/);
  assert.equal(warning.includes(baseEnv.PGPASSWORD), false);
});

test('root CA settings cannot silently turn require or disable into a different TLS policy', () => {
  for (const mode of ['disable', 'require']) {
    for (const root of ['system', caPath, '/missing/synthetic/ca.pem']) {
      assert.throws(() => readPostgresConfig({ ...baseEnv, PGSSLMODE: mode, PGSSLROOTCERT: root }), /PGSSLROOTCERT/);
    }
  }
  assert.throws(() => readPostgresConfig({ ...baseEnv, PGSSLROOTCERT: caPath }), /PGSSLROOTCERT/);
});

function pemCertificates(value) {
  return (
    (Array.isArray(value) ? value.join('\n') : String(value)).match(
      /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g
    ) || []
  );
}

test('verify-full explicitly uses bundled and system roots when no custom CA is selected', () => {
  const expectedRoots = [...getCACertificates('bundled'), ...getCACertificates('system')].flatMap(pemCertificates);
  assert.ok(expectedRoots.length > 0);
  for (const root of [undefined, '', 'system']) {
    const warnings = [];
    const { ssl } = readPostgresConfig(
      { ...baseEnv, PGSSLMODE: 'verify-full', PGSSLROOTCERT: root },
      {
        warn: (...args) => warnings.push(args)
      }
    );
    assert.equal(ssl.rejectUnauthorized, true);
    assert.equal(ssl.minVersion, 'TLSv1.2');
    assert.equal(typeof ssl.checkServerIdentity, 'function');
    assert.deepEqual(new Set(pemCertificates(ssl.ca)), new Set(expectedRoots));
    assert.equal(warnings.length, 0);
  }
});

test('a custom PEM CA file replaces the public/system roots without modifying global trust', () => {
  const beforeRoots = getCACertificates('default');
  const { ssl } = readPostgresConfig({ ...baseEnv, PGSSLMODE: 'verify-full', PGSSLROOTCERT: caPath });
  assert.deepEqual(pemCertificates(ssl.ca), pemCertificates(readFileSync(caPath, 'utf8')));
  assert.deepEqual(getCACertificates('default'), beforeRoots);
  assert.equal(ssl.rejectUnauthorized, true);
});

test('custom CA files must be absolute, readable, valid PEM certificate bundles', () => {
  const invalidPem = writeFixture('invalid-ca.pem', 'not a PEM certificate\n');
  const malformedPem = writeFixture(
    'malformed-ca.pem',
    '-----BEGIN CERTIFICATE-----\nnot-base64\n-----END CERTIFICATE-----\n'
  );
  const incompletePem = writeFixture(
    'incomplete-ca.pem',
    `${readFileSync(caPath, 'utf8')}\n-----BEGIN CERTIFICATE-----\nbroken`
  );
  for (const root of [
    'relative-ca.pem',
    '/missing/synthetic/ca.pem',
    directory,
    invalidPem,
    malformedPem,
    incompletePem
  ]) {
    assert.throws(
      () => readPostgresConfig({ ...baseEnv, PGSSLMODE: 'verify-full', PGSSLROOTCERT: root }),
      /PGSSLROOTCERT/
    );
  }
});

test('legacy URL settings fail with migration guidance even alongside otherwise valid PG settings', () => {
  for (const legacy of [
    { DATABASE_URL: 'postgresql://synthetic:secret@db/synthetic?sslmode=disable' },
    { DATABASE_URL_FILE: '/missing/synthetic/url-secret' },
    { DATABASE_URL: 'postgresql://db/synthetic', DATABASE_URL_FILE: '/missing/synthetic/url-secret' }
  ]) {
    assert.throws(
      () => readPostgresConfig({ ...baseEnv, ...legacy }),
      (error) => {
        assert.match(error.message, /DATABASE_URL/);
        assert.match(error.message, /PGHOST/);
        assert.match(error.message, /PGDATABASE/);
        assert.match(error.message, /PGUSER/);
        assert.match(error.message, /PGPASSWORD/);
        assert.equal(error.message.includes('synthetic:secret'), false);
        return true;
      }
    );
  }
  assert.equal(
    readPostgresConfig({ ...baseEnv, DATABASE_URL: '', DATABASE_URL_FILE: '' }).database,
    baseEnv.PGDATABASE
  );
});

test('password files strip exactly one trailing LF or CRLF and preserve other whitespace', () => {
  for (const [fileContents, expected] of [
    ['synthetic', 'synthetic'],
    ['synthetic\n', 'synthetic'],
    ['synthetic\r\n', 'synthetic'],
    ['  synthetic  \n', '  synthetic  '],
    ['synthetic\n\n', 'synthetic\n'],
    ['synthetic\r\n\r\n', 'synthetic\r\n'],
    ['synthetic\r', 'synthetic\r'],
    [' \t \n', ' \t ']
  ]) {
    const path = writeFixture('password-secret', fileContents);
    assert.equal(readPostgresConfig({ ...baseEnv, PGPASSWORD: undefined, PGPASSWORD_FILE: path }).password, expected);
  }
});

test('password files reject missing, empty, relative, unreadable and conflicting values without leaking secrets', () => {
  const empty = writeFixture('empty-password', '\r\n');
  const passwordPath = writeFixture('conflicting-password', 'synthetic_file_secret\n');
  for (const path of [empty, 'relative-password', '/missing/synthetic/password', directory]) {
    assert.throws(
      () => readPostgresConfig({ ...baseEnv, PGPASSWORD: undefined, PGPASSWORD_FILE: path }),
      /PGPASSWORD_FILE/
    );
  }
  assert.throws(
    () => readPostgresConfig({ ...baseEnv, PGPASSWORD_FILE: passwordPath }),
    (error) => {
      assert.match(error.message, /PGPASSWORD/);
      assert.equal(error.message.includes(baseEnv.PGPASSWORD), false);
      assert.equal(error.message.includes('synthetic_file_secret'), false);
      return true;
    }
  );
  assert.equal(
    readPostgresConfig({ ...baseEnv, PGPASSWORD: 'synthetic_file_secret', PGPASSWORD_FILE: passwordPath }).password,
    'synthetic_file_secret'
  );
});

// A deliberately minimal server speaks PostgreSQL's SSLRequest + startup protocol.
// pg.Client itself negotiates TLS and sends its real startup packet. No authentication
// credentials or financial records from the application are involved.
async function postgresFixture(t, { certificate = 'matching', plaintextOnly = false, maxVersion } = {}) {
  const sockets = new Set();
  const state = {
    connections: 0,
    sslRequests: 0,
    plaintextStartups: 0,
    encryptedStartups: 0,
    protocols: [],
    errors: []
  };
  const secureContext = plaintextOnly
    ? undefined
    : createSecureContext({
        ...certificates[certificate],
        minVersion: 'TLSv1.2',
        ...(maxVersion ? { maxVersion } : {})
      });
  const trackSocket = (socket) => {
    sockets.add(socket);
    socket.on('error', () => {}); // Expected client aborts follow rejected certificates.
    socket.on('close', () => sockets.delete(socket));
  };
  const authenticate = (socket, encrypted) => {
    let data = Buffer.alloc(0);
    const onStartup = (chunk) => {
      data = Buffer.concat([data, chunk]);
      if (data.length < 4 || data.length < data.readInt32BE(0)) {
        return;
      }
      socket.off('data', onStartup);
      if (data.readInt32BE(4) !== 196608) {
        state.errors.push('Unexpected PostgreSQL startup protocol');
        socket.destroy();
        return;
      }
      state[encrypted ? 'encryptedStartups' : 'plaintextStartups']++;
      // AuthenticationOk (R/8/0), then ReadyForQuery (Z/5/I).
      socket.write(Buffer.from([82, 0, 0, 0, 8, 0, 0, 0, 0, 90, 0, 0, 0, 5, 73]));
      socket.on('data', (message) => {
        if (message[0] === 88) {
          socket.end(); // Terminate.
        }
      });
    };
    socket.on('data', onStartup);
    return onStartup;
  };
  const server = createServer((socket) => {
    state.connections++;
    trackSocket(socket);
    let first = Buffer.alloc(0);
    const onFirst = (chunk) => {
      first = Buffer.concat([first, chunk]);
      if (first.length < 8) {
        return;
      }
      socket.off('data', onFirst);
      if (first.readInt32BE(0) !== 8 || first.readInt32BE(4) !== 80877103) {
        // Support plaintext only so a silent downgrade would be visible and succeed.
        authenticate(socket, false)(first);
        return;
      }
      state.sslRequests++;
      if (plaintextOnly) {
        socket.write('N');
        authenticate(socket, false);
        return;
      }
      socket.write('S');
      const secureSocket = new TLSSocket(socket, { isServer: true, secureContext });
      trackSocket(secureSocket);
      secureSocket.on('secure', () => state.protocols.push(secureSocket.getProtocol()));
      authenticate(secureSocket, true);
    };
    socket.on('data', onFirst);
  });
  t.after(async () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    if (server.listening) {
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { state, port: server.address().port };
}

async function pgConnect(t, fixture, { mode = 'verify-full', host = '127.0.0.1', root = caPath } = {}) {
  const config = readPostgresConfig(
    {
      ...baseEnv,
      PGHOST: host,
      PGPORT: String(fixture.port),
      PGSSLMODE: mode,
      PGSSLROOTCERT: mode === 'verify-full' ? root : undefined
    },
    { warn: () => {} }
  );
  const client = new pg.Client({ ...config, connectionTimeoutMillis: 3000, sslnegotiation: 'postgres' });
  client.on('error', () => {});
  t.after(() => client.end());
  await client.connect();
  return client;
}

test('verify-full completes a real pg handshake with a matching, trusted IP SAN', { timeout: 10000 }, async (t) => {
  const fixture = await postgresFixture(t);
  const client = await pgConnect(t, fixture);
  assert.equal(client.connection.stream.encrypted, true);
  assert.equal(client.connection.stream.authorized, true);
  assert.equal(fixture.state.encryptedStartups, 1);
  assert.equal(fixture.state.plaintextStartups, 0);
  assert.deepEqual(fixture.state.errors, []);
  assert.ok(fixture.state.protocols.every((protocol) => ['TLSv1.2', 'TLSv1.3'].includes(protocol)));
});

test('verify-full completes a real pg handshake with a matching DNS SAN and TLS 1.2', { timeout: 10000 }, async (t) => {
  const fixture = await postgresFixture(t, { maxVersion: 'TLSv1.2' });
  const client = await pgConnect(t, fixture, { host: 'localhost' });
  assert.equal(client.connection.stream.authorized, true);
  assert.equal(client.connection.stream.getProtocol(), 'TLSv1.2');
  assert.equal(fixture.state.encryptedStartups, 1);
});

for (const [name, server, client, code] of [
  [
    'unknown CA',
    {},
    { root: 'system' },
    /UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT_LOCALLY|SELF_SIGNED_CERT_IN_CHAIN/
  ],
  ['mismatched DNS SAN', { certificate: 'wrong-host' }, { host: 'localhost' }, /ERR_TLS_CERT_ALTNAME_INVALID/],
  ['DNS SAN instead of the required IP SAN', { certificate: 'dns-only' }, {}, /ERR_TLS_CERT_ALTNAME_INVALID/],
  ['expired certificate', { certificate: 'expired' }, {}, /CERT_HAS_EXPIRED/]
]) {
  test(`verify-full rejects ${name} without a plaintext startup or retry`, { timeout: 10000 }, async (t) => {
    const fixture = await postgresFixture(t, server);
    await assert.rejects(pgConnect(t, fixture, client), (error) => {
      assert.match(error.code || '', code);
      return true;
    });
    assert.equal(fixture.state.connections, 1);
    assert.equal(fixture.state.sslRequests, 1);
    assert.equal(fixture.state.encryptedStartups, 0);
    assert.equal(fixture.state.plaintextStartups, 0);
  });
}

for (const mode of ['require', 'verify-full']) {
  test(`${mode} rejects a plaintext-only PostgreSQL server without falling back`, { timeout: 10000 }, async (t) => {
    const fixture = await postgresFixture(t, { plaintextOnly: true });
    await assert.rejects(pgConnect(t, fixture, { mode }), /does not support SSL/);
    assert.equal(fixture.state.connections, 1);
    assert.equal(fixture.state.sslRequests, 1);
    assert.equal(fixture.state.encryptedStartups, 0);
    assert.equal(fixture.state.plaintextStartups, 0);
  });
}

test('require connects with encryption despite an untrusted, mismatched certificate', { timeout: 10000 }, async (t) => {
  const fixture = await postgresFixture(t, { certificate: 'wrong-host' });
  const client = await pgConnect(t, fixture, { mode: 'require' });
  assert.equal(client.connection.stream.encrypted, true);
  assert.equal(client.connection.stream.authorized, false);
  assert.equal(fixture.state.sslRequests, 1);
  assert.equal(fixture.state.encryptedStartups, 1);
  assert.equal(fixture.state.plaintextStartups, 0);
});

test('disable uses a real plaintext PostgreSQL startup without asking for TLS', { timeout: 10000 }, async (t) => {
  const fixture = await postgresFixture(t, { plaintextOnly: true });
  const client = await pgConnect(t, fixture, { mode: 'disable' });
  assert.notEqual(client.connection.stream.encrypted, true);
  assert.equal(fixture.state.sslRequests, 0);
  assert.equal(fixture.state.plaintextStartups, 1);
  assert.equal(fixture.state.encryptedStartups, 0);
});
