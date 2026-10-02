import assert from 'node:assert/strict';
import dns from 'node:dns';
import net from 'node:net';
import tls from 'node:tls';
import { createTelegramClient } from '../../src/lib/telegram.mjs';

// Separate Node process: use the built-in fetch/TLS stack and startup CA loading.
// Only this synthetic hostname is resolved, exclusively to loopback fixtures.
const fixture = JSON.parse(process.argv[2]);
const token = '123456789:synthetic_socket_test_token_1234567890';
const lookups = [],
  causes = [],
  dials = [];
const defaultAttemptTimeout = net.getDefaultAutoSelectFamilyAttemptTimeout();
const tlsConnect = tls.connect;
tls.connect = function (options, ...args) {
  dials.push({
    autoSelectFamily: options.autoSelectFamily,
    attemptTimeout: options.autoSelectFamilyAttemptTimeout,
    rejectUnauthorized: options.rejectUnauthorized,
    servername: options.servername
  });
  return tlsConnect.call(this, options, ...args);
};

const record = (error) => {
  for (const item of [error, error?.cause, ...(error?.cause?.errors || [])]) {
    if (item) {
      causes.push({ name: item.name, code: item.code });
    }
  }
};

dns.lookup = (hostname, options, callback) => {
  assert.equal(hostname, 'api.telegram.org', 'No external DNS lookup is permitted');
  lookups.push({ all: options.all, family: options.family });
  if (fixture.dnsFailure) {
    queueMicrotask(() => callback(Object.assign(new Error(token), { code: 'ENOTFOUND' })));
    return;
  }

  const addresses = [
    ...(fixture.dualStack ? [{ address: '::1', family: 6 }] : []),
    { address: '127.0.0.1', family: 4 }
  ];
  queueMicrotask(() =>
    options.all ? callback(null, addresses) : callback(null, addresses[0].address, addresses[0].family)
  );
};

const client = createTelegramClient({
  token,
  fetchImpl: async (input, options) => {
    const url = new URL(input);
    assert.equal(url.origin, 'https://api.telegram.org');
    assert.equal(url.pathname, `/bot${token}/getMe`);
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    assert.equal(options.body, '{}');
    assert.ok(options.signal instanceof AbortSignal);
    url.port = String(fixture.port);
    try {
      const response = await fetch(url, {
        ...options,
        ...(fixture.fastAbort ? { signal: AbortSignal.any([options.signal, AbortSignal.timeout(250)]) } : {})
      });
      const json = response.json.bind(response);
      response.json = async () => {
        try {
          return await json();
        } catch (error) {
          record(error);
          throw error;
        }
      };

      return response;
    } catch (error) {
      record(error);
      throw error;
    }
  }
});
let output;
try {
  output = { result: await client.request('getMe') };
  if (fixture.alsoUnscoped) {
    const response = await fetch(`https://api.telegram.org:${fixture.port}/unrelated-fetch`, {
      signal: AbortSignal.timeout(12000)
    });
    await response.json();
  }
} catch (error) {
  output = {
    code: error.code,
    message: error.message,
    serialized: JSON.stringify(error),
    causeRetained: !!error.cause
  };
  assert.ok(!output.serialized.includes(token));
  assert.ok(!error.message.includes(token));
}

assert.equal(net.getDefaultAutoSelectFamilyAttemptTimeout(), defaultAttemptTimeout);
console.log(JSON.stringify({ ...output, causes, lookups, dials, defaultAttemptTimeout }));
