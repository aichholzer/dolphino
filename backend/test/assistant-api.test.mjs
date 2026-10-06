import { readTestPostgresConfig } from './helpers/postgres.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { Store } from '../src/lib/store.mjs';
import { createHouseholdAuth } from '../src/lib/household-auth.mjs';
import { createApp } from '../src/app.mjs';
import { validateAndSetGrants } from '../src/lib/access.mjs';
import { createAssistant } from '../src/lib/assistant.mjs';
import { FINANCE_TOOLS, invokeFinanceTool } from '../src/lib/assistant-tools.mjs';
const database = readTestPostgresConfig();
const aggregate = {
  currency: 'AUD',
  from: '2026-09-01',
  to: '2026-09-30',
  accountId: null,
  merchant: null,
  category: null,
  minAmountMinor: null,
  maxAmountMinor: null,
  status: null,
  kind: null,
  groupBy: 'none',
  sortBy: 'key',
  direction: 'asc',
  limit: 20,
  comparePrevious: false
};
const final = {
  text: 'Synthetic authorized summary',
  toolCalls: [],
  continuation: []
};
const tool = (name, args) => ({
  text: '',
  toolCalls: [{ id: randomUUID(), name, arguments: args }],
  continuation: []
});
test(
  'assistant HTTP enforces authenticated tools, private chats/reports and fresh grants during model execution',
  { skip: !database },
  async () => {
    const admin = new pg.Pool(database),
      schema = `assistant_api_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new pg.Pool({
      ...database,
      options: `-c search_path=${schema}`
    });
    let server;
    try {
      const store = new Store(pool, { mode: 'live' });
      await store.migrate();
      const config = {
        mode: 'live',
        host: '127.0.0.1',
        port: 0,
        origin: 'https://dolphino.test',
        currency: 'AUD',
        timezone: 'Australia/Brisbane',
        bootstrapToken: randomBytes(32).toString('base64')
      };
      const auth = createHouseholdAuth({ pool, config });
      await auth.init();
      const req = { headers: {}, socket: { remoteAddress: 'assistant-test' } };
      const password = 'synthetic household password';
      const root = await auth.bootstrap(req, {
        email: 'admin@example.test',
        name: 'Admin',
        password,
        bootstrapToken: config.bootstrapToken
      });
      const users = {};
      for (const name of ['alice', 'bob', 'budget', 'none']) {
        users[name] = (
          await pool.query(
            "INSERT INTO household_users(email,name,role,password_hash) SELECT $1,$2,'member',password_hash FROM household_users WHERE id=$3 RETURNING id",
            [`${name}@example.test`, name, root.user.id]
          )
        ).rows[0].id;
      }

      const baseTx = {
        currency: 'AUD',
        amountMinor: '-1000',
        status: 'posted',
        date: '2026-09-01',
        category: 'Groceries',
        kind: 'expense'
      };
      const a = await store.ingest({
        ...baseTx,
        sourceId: 'a',
        accountId: 'acct_a',
        description: 'Alice private merchant'
      });
      const b = await store.ingest({
        ...baseTx,
        sourceId: 'b',
        accountId: 'acct_b',
        amountMinor: '-2000',
        description: 'Bob private merchant'
      });
      const budget = await store.saveBudget({
        currency: 'AUD',
        month: '2026-09',
        category: 'Groceries',
        capMinor: '2000'
      });
      const grant = (name, value) =>
        store.atomic((c) => validateAndSetGrants(c, users[name], value, { mode: 'live' }), { refresh: false });
      await grant('alice', {
        accounts: [{ accountId: 'acct_a', access: 'view' }]
      });
      await grant('bob', {
        accounts: [{ accountId: 'acct_b', access: 'view' }]
      });
      await grant('budget', {
        budgets: [{ budgetId: budget.id, access: 'view' }]
      });
      const scripted = [],
        received = [];
      let providerCalls = 0;
      let held = null;
      const assistant = createAssistant({
        getProviderConfig: async () => ({
          assistantEnabled: true,
          timezone: config.timezone
        }),
        tools: FINANCE_TOOLS,
        invokeTool: invokeFinanceTool,
        sendTurn: async (input) => {
          providerCalls++;
          received.push(structuredClone(input.messages));
          if (held) {
            const hold = held;
            held = null;
            hold.start(input);
            return hold.promise;
          }

          assert.ok(scripted.length, 'Unexpected mocked model request');
          return scripted.shift();
        }
      });
      const app = createApp({
        store,
        config,
        auth,
        assistant,
        assistantSettings: { getUserStatus: async () => ({ enabled: true }) }
      });
      server = await new Promise((resolve) => {
        const s = app.start(() => resolve(s));
      });
      const url = `http://127.0.0.1:${server.address().port}`;
      const cookies = { admin: root.cookie.split(';')[0] };
      for (const name of Object.keys(users)) {
        const logged = await auth.login(req, {
          email: `${name}@example.test`,
          password
        });
        cookies[name] = logged.cookie.split(';')[0];
      }

      const request = (name, path, method = 'GET', value) =>
        fetch(url + path, {
          method,
          headers: { Cookie: cookies[name] || '', Origin: config.origin },
          ...(value === undefined ? {} : { body: JSON.stringify(value) })
        });
      const json = async (name, path, method = 'GET', value) => {
        const r = await request(name, path, method, value);
        assert.equal(r.status, 200, await r.clone().text());
        return r.json();
      };

      const create = (name) => json(name, '/api/assistant/chats', 'POST', {});
      const send = (
        name,
        id,
        value = {
          message: 'Summarize authorized finances',
          acknowledgeDataSharing: true
        }
      ) => request(name, `/api/assistant/chats/${id}/messages`, 'POST', value);
      assert.equal((await request('anonymous', '/api/assistant/tools')).status, 401);
      assert.equal(
        (
          await fetch(url + '/api/assistant/chats', {
            method: 'POST',
            headers: { Cookie: cookies.alice, Origin: 'https://attacker.test' },
            body: '{}'
          })
        ).status,
        403
      );
      assert.equal((await request('none', '/api/assistant/chats', 'POST', {})).status, 403);
      assert.equal(
        (
          await request('alice', '/api/assistant/chats', 'POST', {
            userId: users.bob
          })
        ).status,
        400
      );
      assert.equal(
        (
          await request('alice', '/api/assistant/tools/finance_accounts', 'POST', {
            currency: 'AUD',
            userId: users.bob
          })
        ).status,
        400
      );
      assert.equal(
        (
          await request('alice', '/api/assistant/tools/sql', 'POST', {
            sql: 'SELECT * FROM transactions'
          })
        ).status,
        400
      );
      assert.equal(
        (
          await request('alice', '/api/assistant/tools/finance_transaction', 'POST', {
            currency: 'AUD',
            transactionId: b.id
          })
        ).status,
        404
      );
      const budgetAccounts = await json('budget', '/api/assistant/tools/finance_accounts', 'POST', { currency: 'AUD' });
      assert.ok(!JSON.stringify(budgetAccounts).includes('acct_'));
      const budgetData = await json('budget', '/api/assistant/tools/finance_budgets', 'POST', {
        currency: 'AUD',
        month: '2026-09',
        budgetId: budget.id
      });
      assert.ok(JSON.stringify(budgetData).includes('3000'));
      assert.ok(!JSON.stringify(budgetData).includes(a.id));
      assert.ok(!JSON.stringify(budgetData).includes(b.id));
      assert.ok(!JSON.stringify(budgetData).includes('acct_'));
      const chat = await create('alice');
      for (const name of ['bob', 'admin']) {
        assert.equal((await request(name, `/api/assistant/chats/${chat.id}`)).status, 404);
        assert.equal((await request(name, `/api/assistant/chats/${chat.id}/cancel`, 'POST', {})).status, 404);
        assert.equal((await send(name, chat.id)).status, 404);
        assert.deepEqual((await json(name, '/api/assistant/chats')).chats, []);
      }

      assert.equal((await send('alice', chat.id, { message: 'No consent' })).status, 400);
      assert.equal(
        (
          await send('alice', chat.id, {
            message: 'x'.repeat(4001),
            acknowledgeDataSharing: true
          })
        ).status,
        400
      );
      assert.equal(providerCalls, 0);
      scripted.push(tool('finance_report', { ...aggregate, title: 'Authorized spending' }), final);
      const answer = await send('alice', chat.id);
      assert.equal(answer.status, 200, await answer.clone().text());
      const result = await answer.json();
      const reportId = result.citations.find((c) => c.reportId)?.reportId;
      assert.ok(reportId);
      assert.ok(!JSON.stringify(received).includes('Bob private merchant'));
      assert.ok(!JSON.stringify(received).includes(b.id));
      const report = await json('alice', `/api/assistant/reports/${reportId}`);
      assert.ok(JSON.stringify(report).includes('1000'));
      assert.ok(!JSON.stringify(report).includes(b.id));
      for (const name of ['bob', 'admin']) {
        assert.equal((await request(name, `/api/assistant/reports/${reportId}`)).status, 404);
      }

      scripted.push(tool('sql', { sql: 'DROP TABLE transactions' }));
      assert.equal((await send('alice', chat.id)).status, 400);
      assert.equal((await store.listTransactions()).length, 2);
      let release, started;
      const startedPromise = new Promise((resolve) => {
        started = resolve;
      });
      held = {
        promise: new Promise((resolve) => {
          release = resolve;
        }),
        start: started
      };
      const inFlight = send('alice', chat.id);
      const input = await startedPromise;
      assert.equal((await send('alice', chat.id)).status, 429);
      await grant('alice', {});
      release(final);
      const revoked = await inFlight;
      assert.ok([403, 409].includes(revoked.status));
      assert.equal(input.signal.aborted, true);
      assert.equal((await request('alice', `/api/assistant/reports/${reportId}`)).status, 404);
      assert.equal((await request('alice', `/api/assistant/chats/${chat.id}`)).status, 404);
      // Restoring identical grants must not resurrect context collected before revocation.
      await grant('alice', {
        accounts: [{ accountId: 'acct_a', access: 'view' }]
      });
      assert.equal((await request('alice', `/api/assistant/chats/${chat.id}`)).status, 404);
      const silentRevocation = await create('alice');
      await grant('alice', {});
      await grant('alice', {
        accounts: [{ accountId: 'acct_a', access: 'view' }]
      });
      assert.ok(
        [404, 409].includes((await request('alice', `/api/assistant/chats/${silentRevocation.id}`)).status),
        'Grant revocation/restoration between requests must invalidate context'
      );
      const cancelChat = await create('bob');
      let cancelStarted;
      const cancelReady = new Promise((resolve) => {
        cancelStarted = resolve;
      });
      held = { promise: new Promise(() => {}), start: cancelStarted };
      const cancellable = send('bob', cancelChat.id);
      const cancelInput = await cancelReady;
      assert.equal((await request('bob', `/api/assistant/chats/${cancelChat.id}/cancel`, 'POST', {})).status, 200);
      assert.equal((await cancellable).status, 409);
      assert.equal(cancelInput.signal.aborted, true);
    } finally {
      if (server) {
        await new Promise((resolve) => server.close(resolve));
      }

      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  }
);
