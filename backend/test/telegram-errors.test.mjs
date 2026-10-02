import test from 'node:test';
import assert from 'node:assert/strict';
import { telegramFixture, syntheticTelegramToken } from './helpers/telegram-fixture.mjs';

for (const scenario of [
  {
    name: 'rejected token',
    response: () => Response.json({ ok: false, error_code: 401, description: syntheticTelegramToken }, { status: 401 }),
    expected: /Telegram rejected the saved bot token/
  },
  {
    name: 'network failure',
    response: () => {
      throw Error(`https://api.telegram.org/bot${syntheticTelegramToken}/getMe`);
    },
    expected: /outbound HTTPS access/
  },
  {
    name: 'rate limit',
    response: () =>
      Response.json(
        { ok: false, parameters: { retry_after: 30 }, description: syntheticTelegramToken },
        { status: 429 }
      ),
    expected: /Telegram is limiting requests/
  },
  { name: 'invalid JSON', response: () => new Response(syntheticTelegramToken), expected: /unexpected response/ },
  { name: 'null JSON', response: () => Response.json(null), expected: /unexpected response/ },
  ...[
    ['DNS failure', 'ENOTFOUND', /could not resolve/],
    ['TLS certificate failure', 'ERR_TLS_CERT_ALTNAME_INVALID', /verified TLS/],
    ['connection deadline', 'UND_ERR_CONNECT_TIMEOUT', /timed out/],
    ['refused socket', 'ECONNREFUSED', /connection was refused/],
    ['unreachable route', 'ENETUNREACH', /unreachable network or host/],
    ['reset socket', 'ECONNRESET', /connection closed/]
  ].map(([name, code, expected]) => ({
    name,
    expected,
    response: () => {
      throw new TypeError(syntheticTelegramToken, {
        cause: new AggregateError([Object.assign(new Error(syntheticTelegramToken), { code })])
      });
    }
  }))
]) {
  test(`Telegram pairing HTTP safely explains ${scenario.name} and leaves delivery disabled`, async () => {
    const f = await telegramFixture();
    try {
      assert.equal((await f.save()).status, 200);
      f.setHook(scenario.response);
      const response = await f.http('/settings/telegram/pair', { method: 'POST', body: {} });
      assert.equal(response.status, 502);
      const result = await response.json();
      assert.match(result.error, scenario.expected);
      assert.ok(!JSON.stringify(result).includes(syntheticTelegramToken));
      assert.ok(!result.error.includes('database availability'));
      const state = await (await f.http('/settings/notifications')).json();
      assert.equal(state.telegram.paired, false);
      assert.equal(state.telegram.enabled, false);
      assert.deepEqual(await f.settings.getValue('telegram.pairing'), {});
    } finally {
      await f.close();
    }
  });
}

test('Telegram real HTTP pairing keeps permission, origin, nonce and explicit-confirmation safeguards', async () => {
  const f = await telegramFixture();
  try {
    assert.equal((await f.save()).status, 200);
    for (const [authCookie, status] of [
      ['', 401],
      [f.memberCookie, 403]
    ]) {
      assert.equal((await f.http('/settings/telegram/pair', { method: 'POST', body: {}, authCookie })).status, status);
    }

    assert.equal(
      (await f.http('/settings/telegram/pair', { method: 'POST', body: {}, origin: 'https://evil.test' })).status,
      403
    );
    assert.equal(f.calls.length, 0);
    const pair = await (await f.http('/settings/telegram/pair', { method: 'POST', body: {} })).json();
    assert.ok(pair.command.startsWith('/pair@'));
    f.setCommand(pair.command);
    const found = await (
      await f.http('/settings/telegram/poll', { method: 'POST', body: { pairingId: pair.pairingId } })
    ).json();
    let state = await (await f.http('/settings/notifications')).json();
    assert.equal(state.telegram.paired, false);
    assert.equal(state.telegram.enabled, false);
    const confirmed = await f.http('/settings/telegram/confirm', {
      method: 'POST',
      body: { pairingId: pair.pairingId, chatId: found.candidate.chatId }
    });
    assert.equal(confirmed.status, 200);
    state = await (await f.http('/settings/notifications')).json();
    assert.equal(state.telegram.paired, true);
    assert.equal(state.telegram.enabled, true);
    assert.ok(!JSON.stringify(state).includes(syntheticTelegramToken));
    assert.ok(!f.calls.includes('sendMessage'));
    assert.equal(
      (
        await f.http('/settings/telegram/confirm', {
          method: 'POST',
          body: { pairingId: pair.pairingId, chatId: found.candidate.chatId }
        })
      ).status,
      409
    );
  } finally {
    await f.close();
  }
});
