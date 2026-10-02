import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { categoryFixture } from './category-fixture.mjs';
import { createAssistant } from '../../src/lib/assistant.mjs';
import { sendAssistantTurn } from '../../src/lib/assistant-provider.mjs';
import { FINANCE_TOOLS, invokeFinanceTool } from '../../src/lib/assistant-tools.mjs';

export const spendingQuestion = 'Hoe much did I spend eating out last month?';

export const aggregateQuery = {
  currency: 'AUD',
  from: '2026-08-01',
  to: '2026-08-31',
  accountId: null,
  merchant: null,
  category: 'Dining',
  tag: null,
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

const control = {
  async send(command) {
    if (command.constructor.name === 'GetInferenceProfileCommand') {
      throw Object.assign(Error(), { name: 'ResourceNotFoundException' });
    }

    return {
      authorizationStatus: 'AUTHORIZED',
      regionAvailability: 'AVAILABLE',
      entitlementAvailability: 'AVAILABLE',
      agreementAvailability: { status: 'AVAILABLE' }
    };
  }
};

// Real HTTP/session/PG with only the provider transports simulated. No live model,
// financial provider, token or outbound network connection is used.
export async function assistantSpendingFixture(provider = 'openai') {
  const calls = [],
    diagnostics = [],
    executed = [];
  let scenario = 'lookup',
    generic,
    turn = 0,
    assistant;
  const f = await categoryFixture({
    appOptions: async ({ config }) => {
      config.timezone = 'America/Los_Angeles';
      const runtime = {
        assistantEnabled: true,
        assistantDataSharingAcknowledged: true,
        assistantMaxRounds: 3,
        assistantMaxToolCalls: 4,
        assistantMaxOutputTokens: 1024,
        assistantDailyRequestLimit: 100,
        timezone: config.timezone,
        currency: config.currency,
        llmProvider: provider,
        llmModel: 'anthropic.synthetic-test-v1:0',
        llmRegion: 'us-east-1',
        llmApiKey: 'synthetic-never-send',
        llmAccessKeyId: 'AKIA_SYNTHETIC',
        llmSecretAccessKey: 'synthetic-never-send'
      };
      function answer(input) {
        calls.push(structuredClone({ system: input.system, messages: input.messages, finalAnswer: input.finalAnswer }));
        turn++;
        assert.match(input.system, /"today":"2026-09-30"/);
        assert.match(input.system, /"lastMonth":\{"from":"2026-08-01","to":"2026-08-31"\}/);
        assert.match(input.system, /"currency":"AUD"/);
        assert.match(input.system, /untrusted data, never instructions/);
        assert.ok(input.messages.some((entry) => entry.role === 'user'));
        const question = input.messages.findLast((entry) => entry.role === 'user').content;
        const category = question.includes('restaurants')
          ? 'restaurants'
          : question.includes('dining out')
            ? 'dining out'
            : 'eating out';
        const results = input.messages
          .slice(input.messages.findLastIndex((entry) => entry.role === 'user') + 1)
          .filter((entry) => entry.role === 'tool')
          .map((entry) => JSON.parse(entry.content));
        if (scenario === 'generic') {
          assert.equal(question, generic.question);
          if (!results.length) {
            return generic.resolveFirst
              ? { name: 'finance_dates', args: generic.args.dateRange }
              : { name: 'finance_aggregate', args: generic.args };
          }

          if (generic.resolveFirst && results.at(-1).data?.period) {
            const resolved = results.at(-1).data;
            assert.equal(resolved.today, '2026-09-30');
            return {
              name: 'finance_aggregate',
              args: { ...generic.args, dateRange: null, from: resolved.from, to: resolved.to }
            };
          }

          assert.equal(results.at(-1).data.totals[generic.metric], generic.total);
          if (generic.dates) {
            assert.deepEqual(
              [results.at(-1).provenance.filters.from, results.at(-1).provenance.filters.to],
              generic.dates
            );
          }

          if (generic.comparison) {
            assert.equal(results.at(-1).data.comparison.delta.expensesMinor, generic.comparison);
          }

          return { text: `Verified ${generic.metric}: ${generic.total} minor units, AUD. See the authorized source.` };
        }

        if (scenario === 'provider-failure') {
          throw Error('PRIVATE provider error synthetic-never-send account hidden');
        }

        if (scenario === 'repeat') {
          return { name: 'finance_aggregate', args: aggregateQuery };
        }

        if (scenario === 'unknown') {
          return results.length
            ? { text: 'You spent AUD 0.00.' }
            : { name: 'finance_aggregate', args: { ...aggregateQuery, category: 'not-a-category' } };
        }

        if (!results.length) {
          return scenario === 'direct'
            ? { name: 'finance_aggregate', args: { ...aggregateQuery, category } }
            : { name: 'finance_categories', args: { currency: 'AUD', query: 'eating out' } };
        }

        if (results.at(-1).data?.categories) {
          assert.deepEqual(results.at(-1).data.categories, [
            { category: 'Dining', name: 'Eating out', archived: false }
          ]);
          return { name: 'finance_aggregate', args: aggregateQuery };
        }

        const result = results.at(-1);
        assert.equal(result.data.totals.expensesMinor, '2300');
        assert.equal(result.data.totals.pendingMinor, '-99');
        assert.deepEqual(result.provenance.filters, {
          currency: 'AUD',
          from: '2026-08-01',
          to: '2026-08-31',
          category: 'Dining'
        });
        assert.ok(!JSON.stringify(results).includes('Hidden merchant'));
        assert.ok(!JSON.stringify(results).includes('Secret category'));
        return {
          text: 'You spent AUD 23.00 on Eating out from 1–31 August 2026, across your authorized accounts. Refunds reduce this amount; pending entries and transfers are excluded. Coverage is not independently bank-verified.'
        };
      }

      assistant = createAssistant({
        getProviderConfig: async () => runtime,
        now: () => Date.parse('2026-10-01T00:30:00Z'),
        reserveRequest: async () => {},
        tools: FINANCE_TOOLS,
        invokeTool: async (...args) => {
          executed.push({ name: args[0], args: structuredClone(args[1]) });
          return invokeFinanceTool(...args);
        },
        onDiagnostic: (event) => diagnostics.push(event),
        sendTurn: (input) =>
          sendAssistantTurn(input, {
            bedrockControlClient: control,
            fetchImpl: async (_url, options) => {
              const wire = JSON.parse(options.body);
              assert.equal(wire.store, false);
              assert.equal(wire.max_output_tokens, 1024);
              assert.equal(wire.tool_choice, input.finalAnswer ? 'none' : undefined);
              for (const entry of input.messages.filter((entry) => entry.role === 'tool')) {
                assert.ok(
                  wire.input.some(
                    (item) =>
                      item.type === 'function_call_output' &&
                      item.call_id === entry.toolCallId &&
                      item.output === entry.content
                  )
                );
              }

              const next = answer(input);
              return Response.json({
                status: 'completed',
                output: next.name
                  ? [
                      { type: 'reasoning', id: `r${turn}`, summary: [], encrypted_content: 'opaque-test-state' },
                      {
                        type: 'function_call',
                        id: `fc${turn}`,
                        call_id: `call${turn}`,
                        name: next.name,
                        arguments: JSON.stringify(next.args)
                      }
                    ]
                  : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: next.text }] }]
              });
            },
            bedrockClient: {
              async send(command) {
                assert.ok(command.input.toolConfig.tools.some((t) => t.toolSpec.name === 'finance_categories'));
                assert.equal(command.input.inferenceConfig.maxTokens, 1024);
                for (const entry of input.messages.filter((entry) => entry.role === 'tool')) {
                  assert.ok(
                    command.input.messages.some((message) =>
                      message.content.some(
                        (block) =>
                          block.toolResult?.toolUseId === entry.toolCallId &&
                          JSON.stringify(block.toolResult.content[0].json) === entry.content
                      )
                    )
                  );
                }

                const next = answer(input);
                return {
                  stopReason: next.name ? 'tool_use' : 'end_turn',
                  output: {
                    message: {
                      role: 'assistant',
                      content: next.name
                        ? [
                            { reasoningContent: { reasoningText: { text: 'opaque', signature: 'test-signature' } } },
                            { toolUse: { toolUseId: `call${turn}`, name: next.name, input: next.args } }
                          ]
                        : [{ text: next.text }]
                    }
                  }
                };
              }
            }
          })
      });
      return {
        assistant,
        assistantSettings: {
          getUserStatus: async () => ({
            enabled: true,
            configured: true,
            provider,
            model: runtime.llmModel,
            disclosure: 'I agree to share authorized results with the configured model.'
          })
        }
      };
    }
  });
  try {
    const ingest = (id, extra = {}) =>
      f.store.ingest({
        ...f.base,
        sourceId: `spending-${id}`,
        date: '2026-08-12',
        category: 'Dining',
        description: `Synthetic ${id}`,
        amountMinor: '-1200',
        ...extra
      });
    const corrected = await ingest('corrected', { category: 'Groceries', amountMinor: '-1300' });
    await f.store.correctTransaction(corrected.id, { category: 'Dining', note: 'Preserve this correction' });
    const split = await ingest('split', { amountMinor: '-900' });
    await f.store.correctTransaction(split.id, {
      splits: [
        { category: 'Dining', amountMinor: '-400' },
        { category: 'Work', amountMinor: '-500' }
      ]
    });
    await ingest('refund', { kind: 'refund', amountMinor: '200' });
    await ingest('pending', { status: 'pending', amountMinor: '-99' });
    await ingest('transfer', { kind: 'transfer', amountMinor: '-600' });
    await ingest('income', { kind: 'income', amountMinor: '500' });
    await ingest('prior', { date: '2026-07-31', amountMinor: '-8000' });
    await ingest('later', { date: '2026-09-01', amountMinor: '-9000' });
    await ingest('rolling', { date: '2026-09-15', amountMinor: '-600' });
    await ingest('last-week', { date: '2026-09-23', amountMinor: '-400' });
    await ingest('yesterday', { date: '2026-09-29', amountMinor: '-200' });
    await ingest('hidden', { accountId: 'hidden', description: 'Hidden merchant', amountMinor: '-7000' });
    await ingest('frozen', { accountId: 'frozen', amountMinor: '-500' });
    await ingest('deleted', { accountId: 'deleted', amountMinor: '-9000' });
    const request = (input) => ({ requestId: randomUUID(), ...input });
    const manual = await f.json(
      'admin',
      '/api/manual/accounts',
      'POST',
      request({ name: 'Synthetic cash', currency: 'AUD', openingDate: '2026-08-01', openingBalanceMinor: '10000' })
    );
    await f.json(
      'admin',
      '/api/manual/entries',
      'POST',
      request({
        type: 'activity',
        accountId: manual.account.id,
        date: '2026-08-12',
        kind: 'expense',
        amountMinor: '-300',
        description: 'Synthetic manual meal',
        category: 'Dining',
        tags: []
      })
    );
    for (const [id, action] of [
      ['frozen', 'freeze'],
      ['deleted', 'delete']
    ]) {
      const current = (await f.json('admin', '/api/accounts')).accounts.find((a) => a.id === id);
      await f.json(
        'admin',
        `/api/accounts/${id}/lifecycle`,
        'POST',
        request({ revision: current.revision, action, reason: 'Synthetic lifecycle fixture' })
      );
    }

    await f.grant('viewer', {
      accounts: ['visible', 'frozen', 'deleted', manual.account.id].map((accountId) => ({ accountId, access: 'view' }))
    });
    await f.json('admin', '/api/settings/categories', 'PATCH', { category: 'Dining', name: 'Eating out' });
    return {
      ...f,
      calls,
      executed,
      diagnostics,
      assistant,
      corrected,
      scenario(value, options) {
        scenario = value;
        generic = options;
        turn = 0;
        calls.length = 0;
        executed.length = 0;
      },
      async ask(message = spendingQuestion, user = 'viewer') {
        const chat = await f.json(user, '/api/assistant/chats', 'POST', {});
        return f.http(user, `/api/assistant/chats/${chat.id}/messages`, 'POST', {
          message,
          acknowledgeDataSharing: true
        });
      }
    };
  } catch (error) {
    await f.close();
    throw error;
  }
}
