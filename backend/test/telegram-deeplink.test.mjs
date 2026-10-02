import test from 'node:test';
import assert from 'node:assert/strict';
import { telegramFixture } from './helpers/telegram-fixture.mjs';

test('Telegram group deep link binds discovery to the current nonce, with explicit confirmation and audience consent', async () => {
  const f = await telegramFixture();
  try {
    assert.equal((await f.save({ audienceConfirmed: false })).status, 200);
    const pair = await (await f.http('/settings/telegram/pair', { method: 'POST', body: {} })).json();
    const link = new URL(pair.deepLink),
      nonce = link.searchParams.get('startgroup'),
      bot = link.pathname.slice(1),
      chat = { id: -987654321, type: 'group', title: 'Synthetic private group' },
      from = { id: 321, is_bot: false },
      botUser = { id: 123456789, is_bot: true, username: bot },
      date = Math.floor(Date.now() / 1000);
    assert.equal(link.origin, 'https://t.me');
    assert.equal(bot, 'dolphinoSyntheticBot');
    assert.match(nonce, /^[A-Za-z0-9_-]{32}$/);
    assert.equal(pair.command, `/pair@${bot} ${nonce}`);
    assert.ok(!JSON.stringify(await f.settings.getValue('telegram.pairing')).includes(nonce));
    assert.ok(!JSON.stringify(await (await f.http('/settings/telegram/pair')).json()).includes(nonce));

    const message = (text, extra = {}) => ({ date, from, chat, text, ...extra });
    const ignored = [
      {
        my_chat_member: {
          chat,
          from,
          date,
          old_chat_member: { user: botUser, status: 'left' },
          new_chat_member: { user: botUser, status: 'member' }
        }
      },
      { message: message(undefined, { new_chat_members: [botUser] }) },
      { message: message('/start') },
      { message: message(`/start@${bot}`) },
      { message: message(`/start@${bot} ${'x'.repeat(32)}`) },
      { message: message(`/start@different_bot ${nonce}`) },
      { message: message(`/start@${bot} ${nonce}`, { from: botUser }) },
      { message: message(`/start@${bot} ${nonce}`, { forward_origin: { type: 'user' } }) },
      { message: message(`/start@${bot} ${nonce}`, { chat: { id: 321, type: 'private' } }) },
      { message: message(`/start@${bot} ${nonce}`, { chat: { ...chat, username: 'public_group' } }) }
    ].map((update, i) => ({ update_id: i + 1, ...update }));
    let updates = ignored;
    f.setHook((method, options) => {
      if (method === 'getUpdates') {
        const request = JSON.parse(options.body);
        assert.deepEqual(request.allowed_updates, ['message']);
        assert.equal(request.limit, 100);
        assert.equal(request.timeout, 3);
        return Response.json({ ok: true, result: updates.filter((u) => u.update_id >= request.offset) });
      }
    });
    const poll = () => f.http('/settings/telegram/poll', { method: 'POST', body: { pairingId: pair.pairingId } });
    let result = await (await poll()).json();
    assert.equal(result.active, true);
    assert.equal(result.candidate, null);
    assert.ok(!f.calls.includes('getChat'), 'membership events and unbound commands cannot discover a candidate');
    const confirmation = { method: 'POST', body: { pairingId: pair.pairingId, chatId: String(chat.id) } };
    assert.equal((await f.http('/settings/telegram/confirm', confirmation)).status, 409);

    updates = [{ update_id: ignored.length + 1, message: message(`/start@${bot} ${nonce}`) }];
    for (const [authCookie, status] of [
      ['', 401],
      [f.memberCookie, 403]
    ]) {
      for (const path of ['poll', 'confirm']) {
        assert.equal((await f.http(`/settings/telegram/${path}`, { ...confirmation, authCookie })).status, status);
      }
    }

    for (const path of ['poll', 'confirm']) {
      assert.equal(
        (await f.http(`/settings/telegram/${path}`, { ...confirmation, origin: 'https://evil.test' })).status,
        403
      );
    }

    result = await (await poll()).json();
    assert.deepEqual(result.candidate, { chatId: String(chat.id), title: chat.title, type: chat.type });
    let state = await (await f.http('/settings/notifications')).json();
    assert.equal(state.telegram.paired, false);
    assert.equal(state.telegram.enabled, false);
    assert.equal((await f.http('/settings/telegram/confirm', confirmation)).status, 200);
    state = await (await f.http('/settings/notifications')).json();
    assert.equal(state.telegram.paired, true);
    assert.equal(state.telegram.enabled, false, 'group confirmation does not bypass household-audience consent');
    assert.equal((await f.settings.getValue('telegram.pairing')).nonceHash, null);
    assert.equal((await f.http('/settings/telegram/confirm', confirmation)).status, 409);
    assert.ok(f.calls.every((method) => ['getMe', 'getWebhookInfo', 'getUpdates', 'getChat'].includes(method)));
  } finally {
    await f.close();
  }
});
