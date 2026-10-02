import { sendAssistantTurn } from './assistant-provider.mjs';
const invalid = () =>
  Object.assign(Error('Model did not complete the synthetic assistant tool contract; choose a compatible model'), {
    status: 502,
    expose: true
  });
// Deliberately has no finance/store access. Only a fixed fictional tool is available.
export async function testAssistantModel(config, dependencies = {}) {
  const tools = [
    {
      name: 'synthetic_budget_summary',
      description: 'Return a fixed fictional budget amount for this compatibility test. Never reads household data.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false
      }
    }
  ];
  const input = {
    config: {
      ...config,
      assistantMaxOutputTokens: Math.min(config.assistantMaxOutputTokens || 256, 256)
    },
    system:
      'This is an explicitly requested synthetic compatibility test. Call synthetic_budget_summary exactly once with empty arguments, then respond with the returned fictional amount. Never call another tool.',
    messages: [
      {
        role: 'user',
        content: 'Read the fictional budget amount using the supplied tool.'
      }
    ],
    tools
  };
  await dependencies.assertConfiguration?.();
  const first = await sendAssistantTurn(input, dependencies);
  await dependencies.assertConfiguration?.();
  const call = first.toolCalls[0];
  if (
    first.toolCalls.length !== 1 ||
    call.name !== tools[0].name ||
    !call.arguments ||
    Array.isArray(call.arguments) ||
    Object.keys(call.arguments).length
  ) {
    throw invalid();
  }

  await dependencies.assertConfiguration?.();
  const second = await sendAssistantTurn(
    {
      ...input,
      messages: [
        ...input.messages,
        ...first.continuation,
        {
          role: 'tool',
          toolCallId: call.id,
          content: JSON.stringify({
            fictional: true,
            currency: 'AUD',
            amountMinor: '1234',
            amount: '12.34'
          })
        }
      ]
    },
    dependencies
  );
  await dependencies.assertConfiguration?.();
  if (second.toolCalls.length || !second.text.trim()) {
    throw invalid();
  }

  return {
    ok: true,
    message: 'Synthetic assistant tool call and response succeeded. No household financial data was read.',
    providerRequests: 2
  };
}
