import { Transform, pipeline } from 'node:stream';
import { BedrockClient, ListFoundationModelsCommand, ListInferenceProfilesCommand } from '@aws-sdk/client-bedrock';
import { isBedrockRegion } from './provider-regions.mjs';

const MAX_MODELS = 1000;
const MAX_PAGES = 10;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const failure = (message, status = 502) => Object.assign(Error(message), { status, expose: true });
const identifier = (value) => typeof value === 'string' && /^[A-Za-z0-9_./:-]{1,500}$/.test(value);
const label = (value, fallback) =>
  typeof value === 'string' &&
  value.trim() &&
  value.length <= 200 &&
  ![...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    ? value.trim()
    : fallback;
const textModel = (model) =>
  Array.isArray(model.inputModalities) &&
  model.inputModalities.includes('TEXT') &&
  Array.isArray(model.outputModalities) &&
  model.outputModalities.includes('TEXT');
const lifecycle = (model) =>
  ['ACTIVE', 'LEGACY'].includes(model?.modelLifecycle?.status) ? model.modelLifecycle.status : 'UNKNOWN';
const modelTarget = (arn) =>
  typeof arn === 'string' &&
  /^arn:aws(?:-[a-z-]+)?:bedrock:([a-z0-9-]+)::foundation-model\/([A-Za-z0-9_./:-]{1,500})$/.exec(arn);

function boundResponse(client) {
  // Bound wire bytes before the SDK JSON deserializer allocates the catalog.
  client.middlewareStack.addRelativeTo(
    (next) => async (args) => {
      const result = await next(args);
      const response = result.response;
      if (!response) {
        return result;
      }

      if (Number(response.headers?.['content-length']) > MAX_RESPONSE_BYTES) {
        response.body?.destroy?.();
        throw failure('Bedrock catalog exceeded its response limit');
      }

      const source = response.body;
      if (source?.pipe) {
        let size = 0;
        const bounded = new Transform({
          transform(chunk, _encoding, done) {
            size += chunk.length;
            done(size > MAX_RESPONSE_BYTES ? failure('Bedrock catalog exceeded its response limit') : null, chunk);
          }
        });
        pipeline(source, bounded, () => {});
        response.body = bounded;
      } else if (source && Buffer.byteLength(source) > MAX_RESPONSE_BYTES) {
        throw failure('Bedrock catalog exceeded its response limit');
      }

      return result;
    },
    { name: 'dolphinoBedrockCatalogBound', relation: 'after', toMiddleware: 'deserializerMiddleware' }
  );
}

function catalogError(error, action) {
  // Never propagate SDK messages, request metadata, credentials or account URLs.
  if (error?.name === 'AccessDeniedException') {
    return failure(
      `Model discovery needs the read-only bedrock:${action} permission in the saved AWS region. You can still enter a model ID manually.`,
      403
    );
  }

  if (
    [
      'ExpiredTokenException',
      'UnrecognizedClientException',
      'InvalidSignatureException',
      'InvalidClientTokenId',
      'SignatureDoesNotMatch'
    ].includes(error?.name)
  ) {
    return failure(
      'AWS could not authenticate model discovery. Check the saved permanent access key, secret and region; manual model entry remains available.',
      409
    );
  }

  if (error?.name === 'ThrottlingException') {
    return failure(
      'AWS throttled model discovery. Wait briefly and load models again, or enter a model ID manually.',
      429
    );
  }

  return failure(
    `Bedrock ${action} could not be completed. Check the saved region and credentials, then retry or enter a model ID manually.`
  );
}

function normalizeModels(foundations, profiles, region) {
  const known = new Map(foundations.filter((item) => identifier(item?.modelId)).map((item) => [item.modelId, item]));
  const models = new Map();
  for (const item of known.values()) {
    // Provisioned-only base IDs cannot be invoked directly. The existing runtime
    // availability guard supports foundation models and inference profiles only.
    if (!textModel(item) || !item.inferenceTypesSupported?.includes('ON_DEMAND')) {
      continue;
    }

    models.set(item.modelId, {
      id: item.modelId,
      name: label(item.modelName, item.modelId),
      provider: label(item.providerName, 'Unknown provider'),
      kind: 'foundation',
      lifecycle: lifecycle(item),
      regions: [region],
      compatibility: 'unverified'
    });
  }

  for (const item of profiles) {
    if (
      !identifier(item?.inferenceProfileId) ||
      item.status !== 'ACTIVE' ||
      !['SYSTEM_DEFINED', 'APPLICATION'].includes(item.type)
    ) {
      continue;
    }

    if (!Array.isArray(item.models) || !item.models.length || item.models.length > 5) {
      continue;
    }

    const targets = item.models.map((model) => modelTarget(model?.modelArn));
    if (targets.some((target) => !target)) {
      continue;
    }

    const backing = targets.map((target) => known.get(target[2]));
    // A destination model need not appear in the source-region catalog. Unknown
    // capabilities stay unverified; known non-text profiles are omitted.
    if (backing.some((model) => model && !textModel(model))) {
      continue;
    }

    const states = backing.map(lifecycle);
    const providers = [...new Set(backing.map((model) => label(model?.providerName, 'Unknown provider')))];
    models.set(item.inferenceProfileId, {
      id: item.inferenceProfileId,
      name: label(item.inferenceProfileName, item.inferenceProfileId),
      provider: providers.length === 1 ? providers[0] : 'Multiple or unknown providers',
      kind: item.type === 'APPLICATION' ? 'application-profile' : 'system-profile',
      lifecycle: states.includes('LEGACY')
        ? 'LEGACY'
        : states.every((state) => state === 'ACTIVE')
          ? 'ACTIVE'
          : 'UNKNOWN',
      regions: [...new Set(targets.map((target) => target[1]))].sort(),
      compatibility: 'unverified'
    });
  }

  return [...models.values()].sort(
    (a, b) =>
      Number(a.lifecycle !== 'ACTIVE') - Number(b.lifecycle !== 'ACTIVE') ||
      a.name.localeCompare(b.name) ||
      a.id.localeCompare(b.id)
  );
}

export async function listBedrockModels(config, dependencies = {}) {
  if (
    config.llmProvider !== 'bedrock' ||
    !isBedrockRegion(config.llmRegion) ||
    !config.llmAccessKeyId ||
    config.llmAccessKeyId.startsWith('ASIA') ||
    !config.llmSecretAccessKey ||
    config.llmSessionToken
  ) {
    throw failure('Save permanent Bedrock credentials and a supported AWS region before loading models.', 409);
  }

  const client =
    dependencies.bedrockControlClient ??
    new BedrockClient({
      region: config.llmRegion,
      credentials: { accessKeyId: config.llmAccessKeyId, secretAccessKey: config.llmSecretAccessKey },
      maxAttempts: 1,
      ignoreConfiguredEndpointUrls: true
    });
  if (!dependencies.bedrockControlClient) {
    boundResponse(client);
  }

  const deadline = AbortSignal.timeout(15000);
  const signal = dependencies.signal ? AbortSignal.any([dependencies.signal, deadline]) : deadline;
  const warnings = [];
  const errors = [];
  let foundations = [],
    profiles = [],
    successful = 0,
    truncated = false;
  try {
    signal.throwIfAborted();
    try {
      const response = await client.send(new ListFoundationModelsCommand({}), { abortSignal: signal });
      if (!Array.isArray(response.modelSummaries)) {
        throw Error();
      }

      truncated ||= response.modelSummaries.length > MAX_MODELS;
      foundations = response.modelSummaries.slice(0, MAX_MODELS);
      successful++;
    } catch (error) {
      errors.push(catalogError(error, 'ListFoundationModels'));
    }

    const tokens = new Set();
    let nextToken;
    try {
      for (let page = 0; page < MAX_PAGES; page++) {
        signal.throwIfAborted();
        const response = await client.send(
          new ListInferenceProfilesCommand({ maxResults: 100, ...(nextToken ? { nextToken } : {}) }),
          { abortSignal: signal }
        );
        if (!Array.isArray(response.inferenceProfileSummaries)) {
          throw Error();
        }

        profiles.push(...response.inferenceProfileSummaries.slice(0, MAX_MODELS - profiles.length));
        nextToken = response.nextToken;
        if (!nextToken) {
          successful++;
          break;
        }

        if (typeof nextToken !== 'string' || nextToken.length > 2048 || /\s/.test(nextToken) || tokens.has(nextToken)) {
          throw Error();
        }

        tokens.add(nextToken);
        if (page === MAX_PAGES - 1 || profiles.length >= MAX_MODELS) {
          truncated = true;
          successful++;
          break;
        }
      }
    } catch (error) {
      errors.push(catalogError(error, 'ListInferenceProfiles'));
      // A partial profile page is useful, but never label it complete.
      if (profiles.length) {
        successful++;
        truncated = true;
      }
    }

    signal.throwIfAborted();
    if (!successful) {
      const denied = errors.find((error) => error.status === 403);
      throw denied ?? errors[0];
    }

    warnings.push(...errors.map((error) => error.message));
    truncated ||= errors.length > 0;
    const models = normalizeModels(foundations, profiles, config.llmRegion);
    truncated ||= models.length > MAX_MODELS;
    if (truncated) {
      warnings.push('The catalog is incomplete because a safety limit or a partial AWS response was reached.');
    }

    return { region: config.llmRegion, models: models.slice(0, MAX_MODELS), warnings, truncated };
  } catch (error) {
    if (signal.aborted) {
      throw failure('Model discovery timed out or was cancelled. Load models again or enter a model ID manually.', 408);
    }

    throw error;
  } finally {
    if (!dependencies.bedrockControlClient) {
      client.destroy();
    }
  }
}

export async function discoverSavedBedrockModels(getSnapshot, revision, dependencies = {}) {
  const snapshot = await getSnapshot();
  if (snapshot.publicState.discoveryRevision !== revision) {
    throw failure('Saved provider settings changed. Reload Settings before loading models.', 409);
  }

  let result, error;
  try {
    result = await listBedrockModels(snapshot.config, dependencies);
  } catch (caught) {
    error = caught;
  }

  // A rotation/clear/provider or region switch invalidates successes AND errors.
  if ((await getSnapshot()).publicState.discoveryRevision !== revision) {
    throw failure('Saved provider settings changed while models were loading. Reload Settings and try again.', 409);
  }

  if (error) {
    throw error;
  }

  return { ...result, revision };
}
