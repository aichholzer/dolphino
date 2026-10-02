import test from 'node:test';
import assert from 'node:assert/strict';
import { sendAssistantTurn } from '../src/lib/assistant-provider.mjs';
const openai = {
  llmProvider: 'openai',
  llmApiKey: 'synthetic-private-key',
  llmModel: 'test-model',
  llmEnabled: false
};
const bedrock = {
  llmProvider: 'bedrock',
  llmRegion: 'ap-southeast-2',
  llmAccessKeyId: 'AKIA_SYNTHETIC',
  llmSecretAccessKey: 'synthetic-aws-secret',
  llmModel: 'anthropic.example-v1:0'
};
const tools = [
  {
    name: 'get_summary',
    description: 'Read a scoped summary',
    parameters: {
      type: 'object',
      properties: { month: { type: 'string' } },
      required: ['month'],
      additionalProperties: false
    }
  }
];
const request = {
  system: 'Use authorized tools only.',
  messages: [{ role: 'user', content: 'How much did I spend?' }],
  tools
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

test('Responses native call IDs, JSON arguments and all reasoning items survive multi-call continuation', async () => {
  const output = [
    {
      id: 'reason1',
      type: 'reasoning',
      summary: [],
      encrypted_content: 'opaque-reasoning'
    },
    {
      type: 'function_call',
      id: 'fc1',
      call_id: 'callA',
      name: 'get_summary',
      arguments: '{"month":"2026-09"}'
    },
    {
      type: 'function_call',
      id: 'fc2',
      call_id: 'callB',
      name: 'get_summary',
      arguments: '{"month":"2026-08"}'
    }
  ];
  const first = await sendAssistantTurn(
    { ...request, config: openai },
    {
      fetchImpl: async (url, options) => {
        assert.equal(url, 'https://api.openai.com/v1/responses');
        assert.equal(options.redirect, 'error');
        const body = JSON.parse(options.body);
        assert.equal(body.store, false);
        assert.equal(body.parallel_tool_calls, false);
        assert.equal(body.max_output_tokens, 1024);
        assert.deepEqual(body.include, ['reasoning.encrypted_content']);
        assert.equal(body.tools[0].type, 'function');
        return Response.json({ status: 'completed', output });
      }
    }
  );
  assert.deepEqual(
    first.toolCalls.map((c) => c.id),
    ['callA', 'callB']
  );
  assert.deepEqual(first.toolCalls[0].arguments, { month: '2026-09' });
  const messages = [
    ...request.messages,
    ...first.continuation,
    {
      role: 'tool',
      toolCallId: 'callA',
      content: JSON.stringify({ spentMinor: '120' })
    },
    { role: 'tool', toolCallId: 'callB', content: { spentMinor: '100' } }
  ];
  const second = await sendAssistantTurn(
    { ...request, messages, config: openai },
    {
      fetchImpl: async (_url, options) => {
        const body = JSON.parse(options.body);
        assert.deepEqual(body.input.slice(1, 4), output);
        assert.deepEqual(
          body.input.slice(4).map((i) => [i.type, i.call_id, JSON.parse(i.output).spentMinor]),
          [
            ['function_call_output', 'callA', '120'],
            ['function_call_output', 'callB', '100']
          ]
        );
        return Response.json({
          status: 'completed',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'Comparison ready.' }]
            }
          ]
        });
      }
    }
  );
  assert.equal(second.text, 'Comparison ready.');
  assert.deepEqual(second.toolCalls, []);
});

test('Bedrock native tool input/results preserve reasoning and batch results in one user message', async () => {
  const message = {
    role: 'assistant',
    content: [
      {
        reasoningContent: {
          reasoningText: { text: 'opaque', signature: 'signature' }
        }
      },
      {
        toolUse: {
          toolUseId: 'useA',
          name: 'get_summary',
          input: { month: '2026-09' }
        }
      },
      {
        toolUse: {
          toolUseId: 'useB',
          name: 'get_summary',
          input: { month: '2026-08' }
        }
      }
    ]
  };
  const first = await sendAssistantTurn(
    { ...request, config: bedrock },
    {
      bedrockControlClient: control,
      bedrockClient: {
        async send(command, options) {
          assert.equal(command.input.toolConfig.tools[0].toolSpec.inputSchema.json, tools[0].parameters);
          assert(!('strict' in command.input.toolConfig.tools[0].toolSpec));
          assert(options.abortSignal);
          return { stopReason: 'tool_use', output: { message } };
        }
      }
    }
  );
  const messages = [
    ...request.messages,
    ...first.continuation,
    ...first.toolCalls.map((c) => ({
      role: 'tool',
      toolCallId: c.id,
      content: { spentMinor: '100' }
    }))
  ];
  const final = await sendAssistantTurn(
    { ...request, messages, config: bedrock },
    {
      bedrockControlClient: control,
      bedrockClient: {
        async send(command) {
          assert.deepEqual(command.input.messages[1], message);
          assert.equal(command.input.messages.length, 3);
          assert.deepEqual(command.input.messages[2], {
            role: 'user',
            content: [
              {
                toolResult: {
                  toolUseId: 'useA',
                  content: [{ json: { spentMinor: '100' } }]
                }
              },
              {
                toolResult: {
                  toolUseId: 'useB',
                  content: [{ json: { spentMinor: '100' } }]
                }
              }
            ]
          });
          return {
            stopReason: 'end_turn',
            output: {
              message: { role: 'assistant', content: [{ text: 'Complete' }] }
            }
          };
        }
      }
    }
  );
  assert.equal(final.text, 'Complete');
});

test('adapter rejects malformed, duplicate and truncated calls, oversized context/response and provider errors without secrets', async () => {
  for (const output of [
    [
      {
        type: 'function_call',
        call_id: 'x',
        name: 'get_summary',
        arguments: 'not json'
      }
    ],
    [
      {
        type: 'function_call',
        call_id: 'x',
        name: 'get_summary',
        arguments: '[]'
      }
    ],
    [1, 2].map(() => ({
      type: 'function_call',
      call_id: 'x',
      name: 'get_summary',
      arguments: '{}'
    }))
  ]) {
    await assert.rejects(
      sendAssistantTurn(
        { ...request, config: openai },
        {
          fetchImpl: async () => Response.json({ status: 'completed', output })
        }
      ),
      /invalid tool/
    );
  }

  await assert.rejects(
    sendAssistantTurn(
      { ...request, config: openai },
      {
        fetchImpl: async () => Response.json({ status: 'incomplete', output: [] })
      }
    ),
    /incomplete/
  );
  await assert.rejects(
    sendAssistantTurn({ ...request, config: openai }, { fetchImpl: async () => new Response('x'.repeat(70000)) }),
    /size limit/
  );
  await assert.rejects(
    sendAssistantTurn({
      ...request,
      config: openai,
      messages: [{ role: 'user', content: 'x'.repeat(140000) }]
    }),
    /size limit/
  );
  await assert.rejects(
    sendAssistantTurn(
      { ...request, config: openai },
      {
        fetchImpl: async () => {
          throw Object.assign(Error(openai.llmApiKey), { expose: true });
        }
      }
    ),
    (error) => !error.message.includes(openai.llmApiKey)
  );
  let called = false;
  await assert.rejects(
    sendAssistantTurn(
      { ...request, config: bedrock },
      {
        bedrockControlClient: {
          send: async () => {
            throw Error(bedrock.llmSecretAccessKey);
          }
        },
        bedrockClient: {
          send: async () => {
            called = true;
          }
        }
      }
    ),
    /unavailable/
  );
  assert.equal(called, false);
});

test('abort is propagated, no retry or provider fallback occurs, credentials never use ambient AWS chain', async () => {
  const controller = new AbortController();
  let calls = 0;
  const running = sendAssistantTurn(
    { ...request, config: openai, signal: controller.signal },
    {
      fetchImpl: async (_url, { signal }) => {
        calls++;
        controller.abort();
        signal.throwIfAborted();
      }
    }
  );
  await assert.rejects(running, /cancelled/);
  assert.equal(calls, 1);
  await assert.rejects(
    sendAssistantTurn({
      ...request,
      config: { ...bedrock, llmSecretAccessKey: '' }
    }),
    /Configure/
  );
  await assert.rejects(
    sendAssistantTurn({
      ...request,
      config: bedrock,
      messages: [{ provider: 'openai', item: { type: 'reasoning' } }]
    }),
    /context changed/
  );
});

test('Bedrock SDK transport bounds bytes before deserialization, without a real endpoint call', async () => {
  const { Readable } = await import('node:stream');
  let calls = 0;
  const handler = {
    async handle() {
      calls++;
      return {
        response: {
          statusCode: 200,
          headers: { 'content-type': 'application/json' },
          body: Readable.from([Buffer.from('{' + ' '.repeat(70000) + '}')])
        }
      };
    },
    destroy() {}
  };
  await assert.rejects(
    sendAssistantTurn(
      { ...request, config: bedrock },
      { bedrockControlClient: control, bedrockRequestHandler: handler }
    ),
    /size limit|unavailable/
  );
  assert.equal(calls, 1);
  const valid = {
    async handle() {
      return {
        response: {
          statusCode: 200,
          headers: { 'content-type': 'application/json' },
          body: Readable.from([
            Buffer.from(
              JSON.stringify({
                stopReason: 'end_turn',
                output: {
                  message: {
                    role: 'assistant',
                    content: [{ text: 'Bounded SDK response' }]
                  }
                }
              })
            )
          ])
        }
      };
    },
    destroy() {}
  };
  const result = await sendAssistantTurn(
    { ...request, config: bedrock },
    { bedrockControlClient: control, bedrockRequestHandler: valid }
  );
  assert.equal(result.text, 'Bounded SDK response');
});

test('OpenAI enables strict native finance tools after recursive schema checks and accepts settings token maximum', async () => {
  const { FINANCE_TOOLS } = await import('../src/lib/assistant-tools.mjs');
  const { isStrictToolSchema } = await import('../src/lib/assistant-provider.mjs');
  assert(FINANCE_TOOLS.every((tool) => isStrictToolSchema(tool.parameters)));
  const nested = {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: { label: { type: ['string', 'null'] } },
          required: ['label'],
          additionalProperties: false
        }
      }
    },
    required: ['items'],
    additionalProperties: false
  };
  assert.equal(isStrictToolSchema(nested), true);
  const invalid = structuredClone(nested);
  invalid.properties.items.items.required = [];
  assert.equal(isStrictToolSchema(invalid), false);
  await assert.rejects(
    sendAssistantTurn({
      ...request,
      config: openai,
      tools: [
        {
          name: 'invalid',
          description: 'bad nested schema',
          strict: true,
          parameters: invalid
        }
      ]
    }),
    /tool definition/
  );
  await sendAssistantTurn(
    {
      ...request,
      config: { ...openai, assistantMaxOutputTokens: 2048 },
      tools: FINANCE_TOOLS
    },
    {
      fetchImpl: async (_url, { body }) => {
        const payload = JSON.parse(body);
        assert.equal(payload.max_output_tokens, 2048);
        assert(payload.tools.every((tool) => tool.strict === true));
        return Response.json({ status: 'completed', output: [] });
      }
    }
  );
  await assert.rejects(
    sendAssistantTurn({
      ...request,
      config: { ...openai, assistantMaxOutputTokens: 2049 }
    }),
    /output limit/
  );
});
