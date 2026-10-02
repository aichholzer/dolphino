import test from 'node:test';
import assert from 'node:assert/strict';
import { suggestCategory } from '../src/lib/llm.mjs';
test('LLM disabled by default and minimises configured payload, suggestions require review', async () => {
  await assert.rejects(suggestCategory({ description: 'test' }, ['Food'], {}), /disabled/);
  let sent;
  const result = await suggestCategory(
    {
      description: 'SHOP 12345678',
      amountMinor: '-12345',
      accountId: 'private',
      date: '2026-09-30'
    },
    ['Food'],
    {
      llmApiKey: 'fictional',
      llmProvider: 'openai',
      llmModel: 'small'
    },
    async (_url, options) => {
      sent = JSON.parse(options.body);
      return Response.json({
        choices: [{ message: { content: '{"category":"Food","reason":"A shop"}' } }]
      });
    }
  );
  assert.equal(result.requiresReview, true);
  const payload = JSON.parse(sent.messages[1].content);
  assert.deepEqual(Object.keys(payload), ['description', 'categories']);
  assert(!payload.description.includes('12345678'));
});
test('LLM rejects invalid category and legacy arbitrary endpoints', async () => {
  const config = {
    llmApiKey: 'fictional',
    llmProvider: 'openai',
    llmModel: 'small'
  };
  await assert.rejects(
    suggestCategory({ description: 'Shop' }, ['Food'], config, async () =>
      Response.json({
        choices: [{ message: { content: '{"category":"Unknown","reason":"?"}' } }]
      })
    ),
    /unknown category/
  );
  await assert.rejects(
    suggestCategory({ description: 'Shop' }, ['Food'], {
      ...config,
      llmProvider: undefined,
      llmBaseUrl: 'https://example.com'
    }),
    /disabled/
  );
});

test('OpenAI classification checks the current shared identity immediately before dispatch', async () => {
  let calls = 0;
  let checks = 0;
  await assert.rejects(
    suggestCategory(
      { description: 'Synthetic' },
      ['Groceries'],
      {
        llmProvider: 'openai',
        llmApiKey: 'synthetic-outdated-key',
        llmModel: 'synthetic-model',
        llmEnabled: true
      },
      {
        assertConfiguration: async () => {
          checks++;
          throw Object.assign(Error('Shared identity changed'), { status: 409 });
        },
        fetchImpl: async () => {
          calls++;
          throw Error('No dispatch allowed');
        }
      }
    )
  );
  assert.equal(checks, 1);
  assert.equal(calls, 0);
});
