import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_ROUNDS, MAX_TOOL_CALLS, createAssistant } from '../src/lib/assistant.mjs';
const tools = [{ name: 'finance_report', parameters: {} }];
function setup(overrides = {}) {
  let context = {
      user: { id: 'alice', role: 'member' },
      fingerprint: 'grants-A',
      finance: { allowed: 'A' }
    },
    calls = 0;
  const getContext = async () => context;
  const assistant = createAssistant({
    getProviderConfig: async () => ({ assistantEnabled: true }),
    tools,
    invokeTool: async (_name, args, { getFinance }) => ({
      data: { allowed: (await getFinance()).allowed },
      provenance: { coverage: 'synthetic' },
      reportQuery: { tool: 'finance_report', args }
    }),
    sendTurn: async () =>
      ++calls === 1
        ? {
            text: '',
            toolCalls: [
              {
                id: 'one',
                name: 'finance_report',
                arguments: { period: 'month' }
              }
            ],
            continuation: [{ provider: 'synthetic', item: 'tool' }]
          }
        : {
            text: 'Synthetic answer',
            toolCalls: [],
            continuation: [{ provider: 'synthetic', item: 'answer' }]
          },
    ...overrides
  });
  return { assistant, getContext, setContext: (v) => (context = v) };
}

test('ephemeral assistant tool citations and regenerated reports are private even from administrators', async () => {
  const { assistant, getContext, setContext } = setup();
  const chat = await assistant.create({ getContext });
  const sent = await assistant.send({
    chatId: chat.id,
    message: 'Report',
    getContext
  });
  assert.equal(sent.reply, 'Synthetic answer');
  assert.equal(sent.chat.messages.length, 2);
  assert.equal(
    (
      await assistant.report({
        reportId: sent.citations[0].reportId,
        getContext
      })
    ).data.allowed,
    'A'
  );
  setContext({
    user: { id: 'admin', role: 'admin' },
    fingerprint: 'all',
    finance: { allowed: 'all' }
  });
  assert.deepEqual((await assistant.list({ getContext })).chats, []);
  await assert.rejects(assistant.get({ chatId: chat.id, getContext }), /not found/);
  await assert.rejects(assistant.report({ reportId: sent.citations[0].reportId, getContext }), /not found/);
  setContext({
    user: { id: 'alice', role: 'member' },
    fingerprint: 'grants-B',
    finance: { allowed: 'B' }
  });
  await assert.rejects(assistant.get({ chatId: chat.id, getContext }), /Permissions changed/);
  assert.equal((await assistant.list({ getContext })).chats.length, 0);
  await assert.rejects(assistant.report({ reportId: sent.citations[0].reportId, getContext }), /not found/);
});
test('permissions revoked during model wait erase context before any tool or answer', async () => {
  let resolve, entered;
  const started = new Promise((r) => (entered = r));
  let invoked = 0;
  const state = setup({
    sendTurn: () => {
      entered();
      return new Promise((r) => (resolve = r));
    },
    invokeTool: async () => {
      invoked++;
    }
  });
  const { assistant, getContext, setContext } = state,
    chat = await assistant.create({ getContext });
  const response = assistant.send({
    chatId: chat.id,
    message: 'Report',
    getContext
  });
  await started;
  setContext({ user: { id: 'alice' }, fingerprint: 'revoked', finance: {} });
  resolve({
    text: 'SECRET',
    toolCalls: [{ id: 'x', name: 'finance_report', arguments: {} }],
    continuation: []
  });
  await assert.rejects(response, /Permissions changed/);
  assert.equal(invoked, 0);
  assert.equal((await assistant.list({ getContext })).chats.length, 0);
});
test('cancel, one active turn, input and unknown tool controls fail closed', async () => {
  let entered;
  const started = new Promise((r) => (entered = r));
  const { assistant, getContext } = setup({
    sendTurn: () => {
      entered();
      return new Promise(() => {});
    }
  });
  const chat = await assistant.create({ getContext });
  await assert.rejects(
    assistant.send({
      chatId: chat.id,
      message: 'x'.repeat(4001),
      getContext
    }),
    /4000/
  );
  const pending = assistant.send({
    chatId: chat.id,
    message: 'x',
    getContext
  });
  await started;
  await assert.rejects(
    assistant.send({
      chatId: chat.id,
      message: 'x',
      getContext
    }),
    /already running/
  );
  await assistant.cancel({ chatId: chat.id, getContext });
  await assert.rejects(pending, /cancelled/);
  assert.equal((await assistant.get({ chatId: chat.id, getContext })).messages.length, 0);
  const forged = setup({
    sendTurn: async () => ({
      text: '',
      toolCalls: [
        {
          id: 'x',
          name: 'execute_sql',
          arguments: { sql: 'SELECT * FROM secrets' }
        }
      ],
      continuation: []
    }),
    invokeTool: () => {
      throw Error('must never execute');
    }
  });
  const other = await forged.assistant.create({
    getContext: forged.getContext
  });
  await assert.rejects(
    forged.assistant.send({
      chatId: other.id,
      message: 'x',
      getContext: forged.getContext
    }),
    /unavailable tool/
  );
});
test('provider errors never append partial conversations', async () => {
  const { assistant, getContext } = setup({
    sendTurn: () => {
      throw Object.assign(Error('provider unavailable'), { status: 502 });
    }
  });
  const c = await assistant.create({ getContext });
  await assert.rejects(
    assistant.send({
      chatId: c.id,
      message: 'x',
      getContext
    }),
    /provider unavailable/
  );
  assert.equal((await assistant.get({ chatId: c.id, getContext })).messages.length, 0);
});

test('mid-turn provider configuration changes abort without committing history', async () => {
  let model = 'old',
    release,
    entered;
  const ready = new Promise((r) => (entered = r));
  const { assistant, getContext } = setup({
    getProviderConfig: async () => ({
      assistantEnabled: true,
      llmModel: model
    }),
    sendTurn: () => {
      entered();
      return new Promise((r) => (release = r));
    }
  });
  const c = await assistant.create({ getContext });
  const pending = assistant.send({
    chatId: c.id,
    message: 'question',
    getContext
  });
  await ready;
  model = 'new';
  release({ text: 'old-provider-answer', toolCalls: [], continuation: [] });
  await assert.rejects(pending, /configuration changed/);
  await assert.rejects(assistant.get({ chatId: c.id, getContext }), /not found/);
});
test('ephemeral chats expire and ten-turn limit is enforced', async () => {
  let clock = 1000;
  const { assistant, getContext } = setup({
    now: () => clock,
    sendTurn: async () => ({
      text: 'answer',
      toolCalls: [],
      continuation: [{ provider: 'synthetic', item: 'answer' }]
    })
  });
  const c = await assistant.create({ getContext });
  for (let i = 0; i < 10; i++) {
    await assistant.send({
      chatId: c.id,
      message: 'question',
      getContext
    });
  }

  await assert.rejects(
    assistant.send({
      chatId: c.id,
      message: 'question',
      getContext
    }),
    /ten turns/
  );
  clock += 1800001;
  await assert.rejects(assistant.get({ chatId: c.id, getContext }), /not found/);
});

test('a model answer without successful source tools is replaced with an honest limitation', async () => {
  const { assistant, getContext } = setup({
    sendTurn: async () => ({
      text: 'You spent $999999 on imaginary purchases',
      toolCalls: [],
      continuation: [{ provider: 'synthetic', item: 'fabricated financial answer' }]
    })
  });
  const c = await assistant.create({ getContext });
  const result = await assistant.send({
    chatId: c.id,
    message: 'How much?',
    getContext
  });
  assert.match(result.reply, /could not verify/);
  assert.ok(!JSON.stringify(result).includes('999999'));
  assert.equal(result.citations.length, 0);
});
test('configuration changes between turns invalidate prior context and global chat memory is bounded', async () => {
  let model = 'old',
    providerCalls = 0;
  const { assistant, getContext, setContext } = setup({
    maxChats: 1,
    getProviderConfig: async () => ({
      assistantEnabled: true,
      llmModel: model
    }),
    sendTurn: async () => {
      providerCalls++;
      return { text: 'answer', toolCalls: [], continuation: [] };
    }
  });
  const c = await assistant.create({ getContext });
  await assistant.send({
    chatId: c.id,
    message: 'first',
    getContext
  });
  model = 'new';
  await assert.rejects(
    assistant.send({
      chatId: c.id,
      message: 'second',
      getContext
    }),
    /configuration changed/
  );
  assert.equal(providerCalls, 1);
  await assistant.create({ getContext });
  setContext({ user: { id: 'bob' }, fingerprint: 'B', finance: {} });
  await assert.rejects(assistant.create({ getContext }), /capacity/);
});
test('every successful tool citation has an owned source download, not only reports', async () => {
  let count = 0;
  const { assistant, getContext } = setup({
    tools: [{ name: 'finance_accounts', parameters: {} }],
    invokeTool: async (name, args) => {
      assert.equal(name, 'finance_accounts');
      assert.deepEqual(args, {});
      return {
        data: [{ id: 'authorized' }],
        provenance: { coverage: 'all permitted accounts' }
      };
    },
    sendTurn: async () =>
      ++count === 1
        ? {
            text: '',
            toolCalls: [{ id: 'a', name: 'finance_accounts', arguments: {} }],
            continuation: []
          }
        : { text: 'Account result', toolCalls: [], continuation: [] }
  });
  const c = await assistant.create({ getContext });
  const result = await assistant.send({
    chatId: c.id,
    message: 'Accounts',
    getContext
  });
  assert.ok(result.citations[0].reportId);
  assert.equal(
    (
      await assistant.report({
        reportId: result.citations[0].reportId,
        getContext
      })
    ).data[0].id,
    'authorized'
  );
});

test('the last round asks for a final answer and never runs another query', async () => {
  // One tool per round reaches the round bound; four per round reach the tool bound first.
  for (const perRound of [1, 4]) {
    let rounds = 0,
      executed = 0;
    const state = setup({
      invokeTool: async () => {
        executed++;
        return { data: {}, provenance: {} };
      },
      sendTurn: async (input) => {
        rounds++;
        const final = rounds === MAX_ROUNDS || (rounds - 1) * perRound >= MAX_TOOL_CALLS;
        assert.equal(input.finalAnswer, final);
        if (final) {
          assert.match(input.system, /Do not request more tools/);
        }

        return {
          text: '',
          toolCalls: Array.from({ length: perRound }, (_, index) => ({
            id: `tool-${rounds}-${index}`,
            name: 'finance_report',
            arguments: {}
          })),
          continuation: []
        };
      }
    });
    const chat = await state.assistant.create({ getContext: state.getContext });
    await assert.rejects(
      state.assistant.send({
        chatId: chat.id,
        message: 'Spending',
        getContext: state.getContext
      }),
      /instead of finishing/
    );
    const expected = perRound === 1 ? MAX_ROUNDS - 1 : MAX_TOOL_CALLS;
    assert.equal(executed, expected);
    assert.equal(rounds, expected / perRound + 1);
    assert.deepEqual((await state.assistant.get({ chatId: chat.id, getContext: state.getContext })).messages, []);
  }
});

test('empty final output after a successful tool is a recoverable error rather than a blank financial answer', async () => {
  let turn = 0;
  const diagnostics = [];
  const state = setup({
    onDiagnostic: (event) => diagnostics.push(event),
    sendTurn: async () =>
      ++turn === 1
        ? { text: '', toolCalls: [{ id: 'first', name: 'finance_report', arguments: {} }], continuation: [] }
        : { text: ' ', toolCalls: [], continuation: [] }
  });
  const chat = await state.assistant.create({ getContext: state.getContext });
  await assert.rejects(
    state.assistant.send({
      chatId: chat.id,
      message: 'PRIVATE question',
      getContext: state.getContext
    }),
    /returned no answer.*Reference:/
  );
  assert.equal(diagnostics.length, 1);
  assert.ok(!JSON.stringify(diagnostics).includes('PRIVATE'));
});

test('tool database failures expose a retry reference and only redacted execution diagnostics', async () => {
  const diagnostics = [];
  const state = setup({
    onDiagnostic: (event) => diagnostics.push(event),
    invokeTool: async () => {
      throw Error('PRIVATE postgres secret bank account amount 999999');
    }
  });
  const chat = await state.assistant.create({ getContext: state.getContext });
  await assert.rejects(
    state.assistant.send({
      chatId: chat.id,
      message: 'PRIVATE household question',
      getContext: state.getContext
    }),
    (error) => {
      assert.equal(error.status, 502);
      assert.match(error.message, /temporarily unavailable.*Retry.*Reference:/);
      assert.ok(!error.message.includes('PRIVATE'));
      assert.ok(!error.message.includes('999999'));
      return true;
    }
  );
  assert.equal(diagnostics[0].phase, 'tool');
  assert.equal(diagnostics[0].lastTool, 'finance_report');
  assert.ok(!JSON.stringify(diagnostics).includes('PRIVATE'));
});

test('each question refreshes local today across midnight and pins that clock across its provider/tool rounds', async () => {
  let clock = Date.parse('2026-10-01T06:59:59Z'),
    calls = 0;
  const times = [];
  const state = setup({
    now: () => clock,
    getProviderConfig: async () => ({ assistantEnabled: true, timezone: 'America/Los_Angeles', currency: 'AUD' }),
    invokeTool: async (_name, _args, options) => {
      times.push(options.now());
      return { data: {}, provenance: {} };
    },
    sendTurn: async (input) => {
      calls++;
      assert.match(input.system, calls <= 2 ? /"today":"2026-09-30"/ : /"today":"2026-10-01"/);
      if (calls % 2) {
        clock = Date.parse('2026-10-01T07:00:01Z');
        return {
          text: '',
          toolCalls: [{ id: `date-${calls}`, name: 'finance_report', arguments: {} }],
          continuation: []
        };
      }

      return { text: 'Verified source.', toolCalls: [], continuation: [] };
    }
  });
  const chat = await state.assistant.create({ getContext: state.getContext });
  for (let i = 0; i < 2; i++) {
    await state.assistant.send({
      chatId: chat.id,
      message: 'What happened yesterday?',
      getContext: state.getContext
    });
  }

  assert.deepEqual(times, [Date.parse('2026-10-01T06:59:59Z'), Date.parse('2026-10-01T07:00:01Z')]);
});
