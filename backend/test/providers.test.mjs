import test from 'node:test';
import assert from 'node:assert/strict';
import {
  suggestCategory,
  testProvider,
  isProviderConfigured,
  testProviderConnection,
  verifyBedrockAvailability
} from '../src/lib/llm.mjs';

const openai = {
  llmProvider: 'openai',
  llmModel: 'gpt-small',
  llmApiKey: 'synthetic-key',
  llmBaseUrl: 'https://evil.example'
};
const bedrock = {
  llmProvider: 'bedrock',
  llmModel: 'us.anthropic.example-v1:0',
  llmRegion: 'ap-southeast-2',
  llmAccessKeyId: 'synthetic-access',
  llmSecretAccessKey: 'synthetic-secret'
};
const bedrockControlClient = {
  async send(command) {
    if (command.constructor.name === 'GetInferenceProfileCommand') {
      return {
        status: 'ACTIVE',
        models: [
          {
            modelArn: 'arn:aws:bedrock:ap-southeast-2::foundation-model/anthropic.example-v1:0'
          }
        ]
      };
    }

    return {
      authorizationStatus: 'AUTHORIZED',
      entitlementAvailability: 'AVAILABLE',
      regionAvailability: 'AVAILABLE',
      agreementAvailability: { status: 'AVAILABLE' }
    };
  }
};
const answer = JSON.stringify({ category: 'Groceries', reason: 'Example' });

test('OpenAI uses fixed endpoint, minimal input, no redirects and bounded output', async () => {
  const result = await suggestCategory(
    { description: 'Shop 123456', amount: 999, account: 'never-send' },
    ['Groceries'],
    openai,
    async (url, request) => {
      assert.equal(String(url), 'https://api.openai.com/v1/chat/completions');
      assert.equal(request.redirect, 'error');
      const body = JSON.parse(request.body);
      assert.equal(body.max_completion_tokens, 150);
      assert.equal(body.store, false);
      assert(!request.body.includes('never-send'));
      assert(!request.body.includes('123456'));
      return Response.json({ choices: [{ message: { content: answer } }] });
    }
  );
  assert.equal(result.category, 'Groceries');
  assert.equal(result.requiresReview, true);
});

test('Bedrock Converse uses requested inference profile, capped tokens and synthetic test', async () => {
  let calls = 0;
  const result = await testProvider(bedrock, {
    bedrockControlClient,
    bedrockClient: {
      async send(command, options) {
        calls++;
        assert.equal(command.constructor.name, 'ConverseCommand');
        assert.equal(command.input.modelId, bedrock.llmModel);
        assert.equal(command.input.inferenceConfig.maxTokens, 150);
        assert.match(command.input.messages[0].content[0].text, /Fictional example/);
        assert(options.abortSignal);
        return { output: { message: { content: [{ text: answer }] } } };
      }
    }
  });
  assert.equal(result.ok, true);
  assert.equal(calls, 1);
});

test('provider errors never leak synthetic credentials, metadata or provider body', async () => {
  for (const config of [openai, bedrock]) {
    await assert.rejects(
      suggestCategory({ description: 'Shop' }, ['Groceries'], config, {
        fetchImpl: async () => {
          throw Error('synthetic-key');
        },
        bedrockControlClient,
        bedrockClient: {
          send: async () => {
            throw Error('synthetic-secret synthetic-session');
          }
        }
      }),
      (error) => !error.message.includes('synthetic') && error.status === 502
    );
  }
});

test('Bedrock validates response category and fails closed on missing explicit credentials', async () => {
  assert.equal(isProviderConfigured({ ...bedrock, llmSecretAccessKey: '' }), false);
  await assert.rejects(testProvider({ ...bedrock, llmSecretAccessKey: '' }), /disabled/);
  await assert.rejects(testProvider({ ...bedrock, llmRegion: 'https://evil.example' }), /disabled/);
  await assert.rejects(
    testProvider(bedrock, {
      bedrockControlClient,
      bedrockClient: {
        send: async () => ({
          output: {
            message: {
              content: [{ text: '{"category":"Unapproved","reason":"x"}' }]
            }
          }
        })
      }
    }),
    /unknown category/
  );
  await assert.rejects(
    testProvider(openai, async () => Response.json({ choices: [{ message: { content: 'not-json' } }] })),
    /invalid suggestion/
  );
});

test('connection check is read-only and never invokes a model', async () => {
  let calls = 0;
  const result = await testProviderConnection(bedrock, {
    stsClient: {
      send: async (command) => {
        calls++;
        assert.equal(command.constructor.name, 'GetCallerIdentityCommand');
        return { Account: 'synthetic-account' };
      }
    }
  });
  assert.equal(calls, 1);
  assert.match(result.message, /only/);
  assert(!JSON.stringify(result).includes('synthetic-account'));
  await testProviderConnection(openai, async (url, request) => {
    assert.match(url, /^https:\/\/api.openai.com\/v1\/models\//);
    assert.equal(request.method, undefined);
    return new Response('{}');
  });
});

test('unavailable, unknown and missing permission models cannot invoke or subscribe', async () => {
  let invocations = 0;
  for (const send of [
    async () => {
      throw Error('AccessDenied synthetic-key');
    },
    async (command) => {
      if (command.constructor.name === 'GetInferenceProfileCommand') {
        throw Object.assign(Error(), { name: 'ResourceNotFoundException' });
      }

      return {
        authorizationStatus: 'NOT_AUTHORIZED',
        entitlementAvailability: 'NOT_AVAILABLE'
      };
    }
  ]) {
    await assert.rejects(
      testProvider(bedrock, {
        bedrockControlClient: { send },
        bedrockClient: {
          send: async () => {
            invocations++;
          }
        }
      }),
      /availability could not be verified/
    );
  }

  assert.equal(invocations, 0);
});

test('foundation model ARN checks availability without profile lookup', async () => {
  const seen = [];
  await verifyBedrockAvailability(
    {
      ...bedrock,
      llmModel: 'arn:aws:bedrock:ap-southeast-2::foundation-model/anthropic.example-v1:0'
    },
    {
      bedrockControlClient: {
        async send(command) {
          seen.push(command);
          return bedrockControlClient.send(command);
        }
      }
    }
  );
  assert.equal(seen.length, 1);
  assert.equal(seen[0].input.modelId, 'anthropic.example-v1:0');
});

test('permanent-key settings reject temporary AWS credentials and unknown regions', async () => {
  assert.equal(isProviderConfigured({ ...bedrock, llmAccessKeyId: 'ASIAtemporary' }), false);
  assert.equal(isProviderConfigured({ ...bedrock, llmSessionToken: 'unsupported' }), false);
  assert.equal(isProviderConfigured({ ...bedrock, llmRegion: 'xx-future-1' }), false);
});

test('maintained Bedrock catalogue exposes commercial regions with Sydney default', async () => {
  const { BEDROCK_REGION_CATALOG, BEDROCK_REGIONS } = await import('../src/lib/provider-regions.mjs');
  assert.equal(BEDROCK_REGION_CATALOG.defaultRegion, 'ap-southeast-2');
  assert.equal(BEDROCK_REGIONS.length, 32);
  assert.equal(new Set(BEDROCK_REGIONS.map(({ id }) => id)).size, BEDROCK_REGIONS.length);
  assert(!BEDROCK_REGIONS.some(({ id }) => id.startsWith('us-gov-')));
  for (const { id } of BEDROCK_REGIONS) {
    assert.equal(isProviderConfigured({ ...bedrock, llmRegion: id }), true);
  }
});

test('all internally constructed AWS clients reject environment endpoint overrides', async (t) => {
  const { BedrockClient } = await import('@aws-sdk/client-bedrock');
  const { BedrockRuntimeClient } = await import('@aws-sdk/client-bedrock-runtime');
  const { STSClient } = await import('@aws-sdk/client-sts');
  const previous = process.env.AWS_ENDPOINT_URL;
  process.env.AWS_ENDPOINT_URL = 'http://127.0.0.1:1/never-send-secrets';
  t.after(() => {
    if (previous === undefined) {
      delete process.env.AWS_ENDPOINT_URL;
    } else {
      process.env.AWS_ENDPOINT_URL = previous;
    }
  });
  const seen = new Set();
  for (const [Client, name, response] of [
    [BedrockClient, 'control', (command) => bedrockControlClient.send(command)],
    [BedrockRuntimeClient, 'runtime', () => ({ output: { message: { content: [{ text: answer }] } } })],
    [STSClient, 'identity', () => ({ Account: 'synthetic' })]
  ]) {
    const original = Client.prototype.send;
    Client.prototype.send = function (command) {
      assert.equal(this.config.ignoreConfiguredEndpointUrls, true);
      seen.add(name);
      return Promise.resolve(response(command));
    };

    t.after(() => {
      Client.prototype.send = original;
    });
  }

  await testProvider(bedrock);
  await testProviderConnection(bedrock);
  assert.deepEqual([...seen].sort(), ['control', 'identity', 'runtime']);
});
