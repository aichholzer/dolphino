import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { BedrockClient, ListFoundationModelsCommand, ListInferenceProfilesCommand } from '@aws-sdk/client-bedrock';
import { listBedrockModels, discoverSavedBedrockModels } from '../src/lib/bedrock-models.mjs';
import { providerSettingsSchema } from '../src/lib/settings.mjs';
import { assistantSettingsSchema } from '../src/lib/assistant-settings.mjs';

const config = {
  llmProvider: 'bedrock',
  llmModel: '',
  llmRegion: 'ap-southeast-2',
  llmAccessKeyId: 'AKIASYNTHETIC',
  llmSecretAccessKey: 'synthetic-secret-only',
  llmEnabled: false
};
const foundation = (id, extra = {}) => ({
  modelId: id,
  modelName: id,
  providerName: 'Synthetic provider',
  inputModalities: ['TEXT'],
  outputModalities: ['TEXT'],
  inferenceTypesSupported: ['ON_DEMAND'],
  modelLifecycle: { status: 'ACTIVE' },
  ...extra
});
const profile = (id, modelId, extra = {}) => ({
  inferenceProfileId: id,
  inferenceProfileName: id,
  status: 'ACTIVE',
  type: 'SYSTEM_DEFINED',
  models: [{ modelArn: `arn:aws:bedrock:us-east-1::foundation-model/${modelId}` }],
  ...extra
});
const fake = (send) => ({ bedrockControlClient: { send } });
const empty = (command) =>
  command instanceof ListFoundationModelsCommand ? { modelSummaries: [] } : { inferenceProfileSummaries: [] };

test('disabled Bedrock credentials can be saved before choosing a model; activation and OpenAI remain strict', () => {
  for (const schema of [providerSettingsSchema, assistantSettingsSchema]) {
    const input = { provider: 'bedrock', region: 'ap-southeast-2', model: '' };
    assert.equal(schema.safeParse(input).success, true);
    assert.equal(schema.safeParse({ ...input, enabled: true, dataSharingAcknowledged: true }).success, false);
    assert.equal(schema.safeParse({ provider: 'openai', model: '' }).success, false);
    assert.equal(schema.safeParse({ ...input, model: ' ' }).success, true);
    assert.equal(schema.safeParse({ ...input, model: '<script>' }).success, false);
    assert.equal(schema.safeParse({ ...input, accessKeyId: 'ASIA-temporary' }).success, false);
  }
});

test('discovery lists text on-demand foundations and paginated system/application profiles without invocation', async () => {
  const commands = [];
  const result = await listBedrockModels(
    config,
    fake(async (command, options) => {
      commands.push(command);
      assert(options.abortSignal instanceof AbortSignal);
      if (command instanceof ListFoundationModelsCommand) {
        assert.deepEqual(command.input, {});
        return {
          modelSummaries: [
            foundation('provider.active'),
            foundation('provider.legacy', { modelLifecycle: { status: 'LEGACY' } }),
            foundation('provider.image', { outputModalities: ['IMAGE'] }),
            foundation('provider.provisioned', { inferenceTypesSupported: ['PROVISIONED'] }),
            foundation('provider.no-text-input', { inputModalities: ['IMAGE'] })
          ]
        };
      }

      assert(command instanceof ListInferenceProfilesCommand);
      assert.equal(command.input.typeEquals, undefined);
      assert.equal(command.input.maxResults, 100);
      if (!command.input.nextToken) {
        return {
          inferenceProfileSummaries: [
            profile('us.provider.active', 'provider.active'),
            profile('image-profile', 'provider.image'),
            profile('inactive', 'provider.active', { status: 'DISABLED' })
          ],
          nextToken: 'page2'
        };
      }

      assert.equal(command.input.nextToken, 'page2');
      return {
        inferenceProfileSummaries: [
          profile('application-a', 'provider.active', { type: 'APPLICATION' }),
          profile('application-b', 'provider.active', { type: 'APPLICATION' }),
          profile('global.provider.new', 'provider.not-in-source-region')
        ]
      };
    })
  );
  assert.equal(commands.length, 3);
  assert.deepEqual(result.models.map((model) => model.id).sort(), [
    'application-a',
    'application-b',
    'global.provider.new',
    'provider.active',
    'provider.legacy',
    'us.provider.active'
  ]);
  assert(result.models.every((model) => model.compatibility === 'unverified'));
  assert.equal(result.models.find((model) => model.id === 'application-a').kind, 'application-profile');
  assert.equal(result.models.find((model) => model.id === 'provider.legacy').lifecycle, 'LEGACY');
  assert.equal(result.models.find((model) => model.id === 'global.provider.new').lifecycle, 'UNKNOWN');
  assert.deepEqual(result.models.find((model) => model.id === 'global.provider.new').regions, ['us-east-1']);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.warnings, []);
  assert(!JSON.stringify(result).includes(config.llmSecretAccessKey));
});

test('partial permissions retain useful choices and sanitize provider failures', async () => {
  for (const failed of [ListFoundationModelsCommand, ListInferenceProfilesCommand]) {
    const result = await listBedrockModels(
      config,
      fake(async (command) => {
        if (command instanceof failed) {
          throw Object.assign(Error(config.llmSecretAccessKey), {
            name: 'AccessDeniedException',
            $metadata: { secret: config.llmSecretAccessKey }
          });
        }

        return command instanceof ListFoundationModelsCommand
          ? { modelSummaries: [foundation('provider.active')] }
          : { inferenceProfileSummaries: [profile('us.provider.active', 'provider.active')] };
      })
    );
    assert.equal(result.models.length, 1);
    assert.match(result.warnings[0], /read-only bedrock:List/);
    assert(!JSON.stringify(result).includes(config.llmSecretAccessKey));
  }

  await assert.rejects(
    listBedrockModels(
      config,
      fake(async () => {
        throw Object.assign(Error(config.llmSecretAccessKey), { name: 'AccessDeniedException' });
      })
    ),
    (error) => error.status === 403 && !error.message.includes(config.llmSecretAccessKey)
  );
});

test('discovery rejects incomplete, temporary, wrong-provider and unsupported-region configurations before I/O', async () => {
  for (const overrides of [
    { llmProvider: 'openai' },
    { llmRegion: 'invalid.example' },
    { llmRegion: '' },
    { llmAccessKeyId: '' },
    { llmAccessKeyId: 'ASIA-temporary' },
    { llmSecretAccessKey: '' },
    { llmSessionToken: 'token' }
  ]) {
    await assert.rejects(
      listBedrockModels(
        { ...config, ...overrides },
        fake(() => assert.fail('must not call AWS'))
      ),
      { status: 409 }
    );
  }
});

test('profile pagination has page, entry and repeated-token bounds with honest partial results', async () => {
  let pages = 0;
  const result = await listBedrockModels(
    config,
    fake(async (command) => {
      if (command instanceof ListFoundationModelsCommand) {
        return { modelSummaries: [] };
      }

      pages++;
      return {
        inferenceProfileSummaries: [profile(`profile-${pages}`, 'provider.active')],
        nextToken: `next-${pages}`
      };
    })
  );
  assert.equal(pages, 10);
  assert.equal(result.models.length, 10);
  assert.equal(result.truncated, true);
  assert.match(result.warnings.at(-1), /incomplete/);
  pages = 0;
  const repeated = await listBedrockModels(
    config,
    fake(async (command) => {
      if (command instanceof ListFoundationModelsCommand) {
        return { modelSummaries: [] };
      }

      pages++;
      return { inferenceProfileSummaries: [profile('profile-a', 'provider.active')], nextToken: 'same' };
    })
  );
  assert.equal(pages, 2);
  assert.equal(repeated.models.length, 1);
  assert.equal(repeated.truncated, true);
  const bounded = await listBedrockModels(
    config,
    fake(async (command) =>
      command instanceof ListFoundationModelsCommand
        ? { modelSummaries: Array.from({ length: 1001 }, (_, i) => foundation(`provider.model${i}`)) }
        : { inferenceProfileSummaries: [] }
    )
  );
  assert.equal(bounded.models.length, 1000);
  assert.equal(bounded.truncated, true);
});

test('aborted discovery never starts or continues provider work', async () => {
  await assert.rejects(
    listBedrockModels(config, { ...fake(() => assert.fail('must not call AWS')), signal: AbortSignal.abort() }),
    { status: 408 }
  );
  const cancel = new AbortController();
  let calls = 0;
  await assert.rejects(
    listBedrockModels(config, {
      signal: cancel.signal,
      ...fake(async (command) => {
        calls++;
        cancel.abort();
        return empty(command);
      })
    }),
    { status: 408 }
  );
  assert.equal(calls, 1);
});

test('saved revision fences stale starts and changes during success or failure', async () => {
  let revision = 'a'.repeat(64);
  const snapshot = async () => ({ config, publicState: { discoveryRevision: revision } });
  await assert.rejects(
    discoverSavedBedrockModels(
      snapshot,
      'b'.repeat(64),
      fake(() => assert.fail('stale before I/O'))
    ),
    { status: 409 }
  );
  for (const fail of [false, true]) {
    revision = 'a'.repeat(64);
    await assert.rejects(
      discoverSavedBedrockModels(
        snapshot,
        revision,
        fake(async (command) => {
          revision = 'b'.repeat(64);
          if (fail) {
            throw Error('provider secret');
          }

          return empty(command);
        })
      ),
      (error) => error.status === 409 && /changed while/.test(error.message)
    );
  }

  const result = await discoverSavedBedrockModels(
    snapshot,
    revision,
    fake(async (command) => empty(command))
  );
  assert.equal(result.revision, revision);
});

test('real SDK transport uses only explicit saved credentials/fixed regional host, bounded response and no retries', async (t) => {
  const original = BedrockClient.prototype.send;
  const requests = [];
  let large = false;
  let destroyed = 0;
  t.mock.method(BedrockClient.prototype, 'destroy', () => {
    destroyed++;
  });
  t.mock.method(BedrockClient.prototype, 'send', function (command, options) {
    assert.equal(this.config.ignoreConfiguredEndpointUrls, true);
    assert.equal(this.config.maxAttempts instanceof Function ? true : this.config.maxAttempts === 1, true);
    this.config.requestHandler = {
      handle: async (request) => {
        requests.push(request);
        assert.equal(request.hostname, 'bedrock.ap-southeast-2.amazonaws.com');
        assert.match(request.headers.authorization, /Credential=AKIASYNTHETIC\//);
        return {
          response: {
            statusCode: 200,
            headers: { 'content-type': 'application/json' },
            body: Readable.from([large ? Buffer.alloc(1024 * 1024 + 1, 'x') : JSON.stringify(empty(command))])
          }
        };
      }
    };
    return original.call(this, command, options);
  });
  assert.deepEqual((await listBedrockModels(config)).models, []);
  assert.equal(requests.length, 2);
  assert.equal(destroyed, 1);
  large = true;
  await assert.rejects(
    listBedrockModels(config),
    (error) => error.status === 502 && !error.message.includes(config.llmSecretAccessKey)
  );
  assert.equal(requests.length, 4);
  assert.equal(destroyed, 2);
});
