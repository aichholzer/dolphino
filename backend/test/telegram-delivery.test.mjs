import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { telegramFixture, syntheticTelegramToken } from './helpers/telegram-fixture.mjs';
import { sendTelegram, verifyTelegramPrivateGroup } from '../src/lib/telegram.mjs';

const options = { timeout: 15000 };
const replacement = '123456789:replacement_synthetic_delivery_token_123456789';
const privateChat = { id: -987654321, type: 'supergroup', title: 'Synthetic private group' };
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

async function fixture(t) {
  const calls = [],
    sends = [];
  let chat = { ...privateChat },
    hook;
  const fetchImpl = async (url, request) => {
    const method = new URL(url).pathname.split('/').at(-1),
      body = JSON.parse(request.body);
    assert.ok(['getChat', 'sendMessage'].includes(method));
    assert.equal(request.redirect, 'error');
    assert.ok(request.signal instanceof AbortSignal);
    calls.push({ method, body });
    if (method === 'sendMessage') {
      sends.push({ token: new URL(url).pathname.split('/')[1].slice(3), ...body });
    }

    const response = await hook?.(method, body);
    return response || Response.json({ ok: true, result: method === 'getChat' ? chat : { message_id: 123 } });
  };

  const f = await telegramFixture({
    notificationOptions: {
      verifyTelegramGroup: (input) => verifyTelegramPrivateGroup({ ...input, fetchImpl }),
      sendTelegram: (input) => {
        assert.ok(Object.isFrozen(input));
        return sendTelegram({ ...input, fetchImpl });
      }
    }
  });
  t.after(() => f.close());
  assert.equal((await f.save()).status, 200);
  const pair = await (await f.http('/settings/telegram/pair', { method: 'POST', body: {} })).json();
  f.setCommand(pair.command);
  const found = await (await f.http('/settings/telegram/poll', { method: 'POST', body: {} })).json();
  assert.equal(
    (
      await f.http('/settings/telegram/confirm', {
        method: 'POST',
        body: { pairingId: pair.pairingId, chatId: found.candidate.chatId }
      })
    ).status,
    200
  );
  const id = randomUUID();
  let revision = 0;
  const event = async () => {
    if (!revision) {
      await f.pool.query(
        "INSERT INTO budget_alerts(id,mode,currency,month,category,type,amount_minor,message) VALUES($1,'live','AUD','2026-09','Dining','overspend',100,'Synthetic alert')",
        [id]
      );
    }

    await f.pool.query("INSERT INTO notification_events(alert_id,revision,mode,payload) VALUES($1,$2,'live',$3)", [
      id,
      ++revision,
      {
        category: 'Synthetic sensitive category',
        month: '2026-09',
        currency: 'AUD',
        amountMinor: '100',
        state: 'opened'
      }
    ]);
  };

  const state = async () => {
    const response = await f.http('/settings/notifications');
    assert.equal(response.status, 200);
    const json = await response.json();
    for (const secret of [syntheticTelegramToken, replacement, 'provider-private-detail']) {
      assert.ok(!JSON.stringify(json).includes(secret));
    }

    return json;
  };

  const due = () =>
    f.pool.query("UPDATE notification_outbox SET next_attempt_at=now(),updated_at=now()-interval '10 seconds'");
  return {
    ...f,
    event,
    state,
    due,
    calls,
    sends,
    setChat: (value) => {
      chat = value;
    },
    setTransportHook: (value) => {
      hook = value;
    }
  };
}

test('Telegram financial delivery rechecks the current private group on every send and retry', options, async (t) => {
  const f = await fixture(t);
  await f.event();
  await f.notifications.processPending();
  assert.deepEqual(
    f.calls.map((c) => c.method),
    ['getChat', 'sendMessage']
  );
  assert.equal(f.sends[0].chat_id, String(privateChat.id));
  assert.equal(f.sends[0].token, syntheticTelegramToken);
  await f.event();
  await f.due();
  f.setTransportHook((method) =>
    method === 'sendMessage'
      ? Response.json(
          { ok: false, error_code: 429, parameters: { retry_after: 900 }, description: 'provider-private-detail' },
          { status: 429 }
        )
      : undefined
  );
  await f.notifications.processPending();
  const pending = (await f.notifications.deliveries())[0];
  assert.equal(pending.status, 'pending');
  assert.ok(new Date(pending.nextAttemptAt) - Date.now() > 890000);
  f.setChat({ ...privateChat, username: 'public_now' });
  await f.due();
  await f.notifications.processPending();
  assert.equal(f.sends.length, 2, 'retry must stop when a formerly private group is public');
  assert.equal((await f.notifications.deliveries())[0].status, 'failed');
  assert.match((await f.state()).recentFailures[0].error, /could not be verified as private/);
});

for (const [name, chat] of [
  ['public username', { ...privateChat, username: 'public_now' }],
  ['public alias', { ...privateChat, active_usernames: ['public_now'] }],
  ['different group ID', { ...privateChat, id: -456789 }],
  ['direct message', { id: 321, type: 'private' }],
  ['channel', { ...privateChat, type: 'channel' }],
  ['malformed chat', null]
]) {
  test(`Telegram financial delivery fails closed for ${name} after confirmation`, options, async (t) => {
    const f = await fixture(t);
    f.setChat(chat);
    await f.event();
    await f.notifications.processPending();
    assert.equal(f.sends.length, 0);
    const failed = (await f.notifications.deliveries())[0];
    assert.equal(failed.status, 'failed');
    assert.equal(failed.attempts, 1);
    assert.match(failed.error, /Make it private or pair another private group, then retry/);
    await f.state();
    // An explicit retry revalidates privacy instead of trusting the old pairing.
    f.setChat(privateChat);
    assert.equal((await f.http(`/notifications/${failed.id}/retry`, { method: 'POST', body: {} })).status, 200);
    await f.due();
    await f.notifications.processPending();
    assert.equal(f.sends.length, 1);
  });
}

for (const [name, failure] of [
  [
    'network failure',
    () => {
      throw new TypeError(`provider-private-detail ${syntheticTelegramToken}`);
    }
  ],
  ['invalid JSON', () => new Response('provider-private-detail')],
  [
    'rate limit',
    () =>
      Response.json(
        { ok: false, error_code: 429, parameters: { retry_after: 900 }, description: syntheticTelegramToken },
        { status: 429 }
      )
  ]
]) {
  test(`Telegram privacy ${name} sends no financial text and keeps bounded durable retries`, options, async (t) => {
    const f = await fixture(t);
    f.setTransportHook(failure);
    await f.event();
    for (let attempt = 1; attempt <= 5; attempt++) {
      await f.due();
      await f.notifications.processPending();
      const delivery = (await f.notifications.deliveries())[0];
      assert.equal(delivery.attempts, attempt);
      assert.equal(delivery.status, attempt < 5 ? 'pending' : 'failed');
      assert.match(delivery.error, /privacy check failed; no financial message was sent/);
      if (name === 'rate limit') {
        assert.ok(new Date(delivery.nextAttemptAt) - Date.now() > 890000);
      }
    }

    await f.notifications.processPending();
    assert.equal(f.calls.length, 5);
    assert.equal(f.sends.length, 0);
    await f.state();
  });
}

for (const [name, change] of [
  ['token replacement', { telegram: { enabled: false, token: replacement } }],
  ['disable', { telegram: { enabled: false } }],
  ['audience revocation', { audienceConfirmed: false }],
  ['summary field change', { summaryFields: ['period'] }]
]) {
  test(`Telegram ${name} during privacy verification prevents dispatch of the old snapshot`, options, async (t) => {
    const f = await fixture(t),
      entered = deferred(),
      release = deferred();
    t.after(release.resolve);
    f.setTransportHook(async (method) => {
      if (method === 'getChat') {
        entered.resolve();
        await release.promise;
      }
    });
    await f.event();
    const running = f.notifications.processPending();
    await entered.promise;
    // Completes while the network check is blocked: no configuration/transaction lock spans it.
    assert.equal((await f.http('/settings/notifications', { method: 'PUT', body: change })).status, 200);
    release.resolve();
    await running;
    assert.equal(f.sends.length, 0);
    const delivery = (await f.notifications.deliveries())[0];
    assert.equal(delivery.status, name === 'summary field change' ? 'pending' : 'cancelled');
    if (name === 'summary field change') {
      f.setTransportHook(null);
      await f.due();
      await f.notifications.processPending();
      assert.equal(f.sends.length, 1);
      assert.ok(!f.sends[0].text.includes('Synthetic sensitive category'));
      assert.equal(f.calls.filter((c) => c.method === 'getChat').length, 2);
    }

    await f.state();
  });
}

test(
  'Telegram delivery defers without waiting when another process holds the configuration lock',
  options,
  async (t) => {
    const f = await fixture(t),
      writer = await f.pool.connect();
    try {
      await writer.query('BEGIN');
      await writer.query('SELECT pg_advisory_xact_lock(17092382)');
      await f.event();
      await f.notifications.processPending();
      assert.equal(f.sends.length, 0);
      assert.equal((await f.notifications.deliveries())[0].status, 'pending');
    } finally {
      await writer.query('ROLLBACK');
      writer.release();
    }

    await f.due();
    await f.notifications.processPending();
    assert.equal(f.sends.length, 1);
  }
);

test(
  'Telegram final credential read is serialized with replacement, and a started send releases the lock before its response',
  options,
  async (t) => {
    const f = await fixture(t),
      credentialRead = deferred(),
      releaseRead = deferred(),
      networkStarted = deferred(),
      releaseNetwork = deferred();
    t.after(() => {
      releaseRead.resolve();
      releaseNetwork.resolve();
    });
    const original = f.settings.getSecret;
    let reads = 0;
    f.settings.getSecret = async (...args) => {
      if (args[0] === 'notifications.telegram.botToken' && ++reads === 2) {
        credentialRead.resolve();
        await releaseRead.promise;
      }

      return original(...args);
    };

    f.setTransportHook(async (method) => {
      if (method === 'sendMessage') {
        networkStarted.resolve();
        await releaseNetwork.promise;
      }
    });
    await f.event();
    const running = f.notifications.processPending();
    await credentialRead.promise;
    const changing = f.http('/settings/notifications', {
      method: 'PUT',
      body: { telegram: { enabled: false, token: replacement } }
    });
    let waiting = false;
    for (let i = 0; i < 200; i++) {
      waiting = (
        await f.pool.query(
          "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=17092382 AND NOT granted) waiting"
        )
      ).rows[0].waiting;
      if (waiting) {
        break;
      }

      await new Promise((r) => setTimeout(r, 5));
    }

    assert.ok(waiting, 'the settings writer must wait for the final dispatch gate');
    releaseRead.resolve();
    await networkStarted.promise;
    assert.equal(
      (await changing).status,
      200,
      'configuration can change while the already-started request awaits its response'
    );
    assert.equal((await f.state()).telegram.paired, false);
    assert.equal(f.sends[0].token, syntheticTelegramToken, 'never read the replacement token for an old destination');
    releaseNetwork.resolve();
    await running;
    assert.equal((await f.notifications.deliveries())[0].status, 'sent');
  }
);

test(
  'Telegram re-pairing during verification cancels the old destination instead of retargeting its alert',
  options,
  async (t) => {
    const f = await fixture(t),
      entered = deferred(),
      release = deferred();
    t.after(release.resolve);
    f.setTransportHook(async (method) => {
      if (method === 'getChat') {
        entered.resolve();
        await release.promise;
      }
    });
    await f.event();
    const running = f.notifications.processPending();
    await entered.promise;
    const pair = await (await f.http('/settings/telegram/pair', { method: 'POST', body: {} })).json();
    const next = { id: -456789, type: 'supergroup', title: 'Another synthetic household' };
    f.setHook((method) => {
      if (method === 'getChat') {
        return Response.json({ ok: true, result: next });
      }

      if (method === 'getUpdates') {
        return Response.json({
          ok: true,
          result: [
            {
              update_id: 2,
              message: {
                date: Math.floor(Date.now() / 1000),
                from: { is_bot: false },
                chat: next,
                text: pair.command
              }
            }
          ]
        });
      }
    });
    const found = await (await f.http('/settings/telegram/poll', { method: 'POST', body: {} })).json();
    assert.equal(found.candidate.chatId, String(next.id));
    assert.equal(
      (
        await f.http('/settings/telegram/confirm', {
          method: 'POST',
          body: {
            pairingId: pair.pairingId,
            chatId: found.candidate.chatId
          }
        })
      ).status,
      200
    );
    release.resolve();
    await running;
    assert.equal(f.sends.length, 0);
    assert.equal((await f.notifications.deliveries())[0].status, 'cancelled');
    assert.equal((await f.state()).telegram.chatTitle, next.title);
    f.setChat(next);
    f.setTransportHook(null);
    await f.event();
    await f.due();
    await f.notifications.processPending();
    assert.equal(f.sends.length, 1);
    assert.equal(f.sends[0].chat_id, String(next.id));
  }
);

test('Telegram refuses an out-of-band token change that is not bound to the confirmed group', options, async (t) => {
  const f = await fixture(t);
  await f.settings.setSecret('notifications.telegram.botToken', 'telegram', replacement);
  await f.event();
  await f.notifications.processPending();
  assert.equal(f.calls.length, 0);
  assert.equal(f.sends.length, 0);
  assert.match((await f.notifications.deliveries())[0].error, /saved token does not match a confirmed group/);
  await f.state();
});
