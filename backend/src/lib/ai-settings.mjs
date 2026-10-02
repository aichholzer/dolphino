import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canEncrypt, decryptSecret } from './crypto.mjs';
import { providerSettingsSchema, disabledProviderConfig } from './settings.mjs';
import { assistantSettingsSchema, assistantDisclosure } from './assistant-settings.mjs';
import { BEDROCK_REGION_CATALOG } from './provider-regions.mjs';

const fields = ['apiKey', 'accessKeyId', 'secretAccessKey'];
const required = (provider) => (provider === 'bedrock' ? ['accessKeyId', 'secretAccessKey'] : ['apiKey']);
const namespaces = { classification: 'ai.classification', assistant: 'ai.assistant' };
const previousNamespaces = { classification: 'llm', assistant: 'assistant.llm' };
const revisionSchema = z.string().regex(/^[a-f0-9]{64}$/);
const failure = (message, status = 409) => Object.assign(Error(message), { status });
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const shape = providerSettingsSchema.shape;

export const sharedAiSettingsSchema = z
  .object({
    revision: revisionSchema,
    provider: shape.provider,
    region: shape.region,
    apiKey: shape.apiKey,
    accessKeyId: shape.accessKeyId,
    secretAccessKey: shape.secretAccessKey,
    reuseCredentialsFrom: z.enum(['classification', 'assistant']).optional()
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.provider === 'bedrock' && !value.region) {
      ctx.addIssue({ code: 'custom', message: 'Choose a supported AWS region', path: ['region'] });
    }

    if (value.provider === 'openai' && value.region) {
      ctx.addIssue({ code: 'custom', message: 'OpenAI does not use an AWS region', path: ['region'] });
    }

    for (const field of fields.filter((name) => !required(value.provider).includes(name))) {
      if (value[field] !== undefined) {
        ctx.addIssue({ code: 'custom', message: 'Credential does not belong to the selected provider', path: [field] });
      }
    }

    if (value.accessKeyId?.startsWith('ASIA')) {
      ctx.addIssue({ code: 'custom', message: 'Temporary AWS credentials are not supported', path: ['accessKeyId'] });
    }

    if (value.reuseCredentialsFrom && fields.some((field) => value[field] !== undefined)) {
      ctx.addIssue({
        code: 'custom',
        message: 'Choose an existing profile or enter replacement credentials, not both'
      });
    }
  });

const classificationSchema = z
  .object({
    model: shape.model.default(''),
    enabled: shape.enabled,
    autoClassify: shape.autoClassify,
    autoApply: shape.autoApply,
    dailyRequestLimit: shape.dailyRequestLimit,
    batchSize: shape.batchSize
  })
  .strict();
const assistantShape = assistantSettingsSchema.shape;
const assistantSchema = z
  .object({
    model: shape.model.default(''),
    enabled: assistantShape.enabled,
    dataSharingAcknowledged: assistantShape.dataSharingAcknowledged,
    dailyRequestsPerUser: assistantShape.dailyRequestsPerUser,
    maxToolCalls: assistantShape.maxToolCalls,
    maxRounds: assistantShape.maxRounds,
    maxOutputTokens: assistantShape.maxOutputTokens
  })
  .strict();
const schemas = { classification: classificationSchema, assistant: assistantSchema };
const defaults = Object.fromEntries(Object.entries(schemas).map(([name, schema]) => [name, schema.parse({})]));
const sharedValueSchema = z
  .object({ provider: shape.provider, region: shape.region })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.provider === 'bedrock' && !value.region) || (value.provider === 'openai' && value.region)) {
      ctx.addIssue({ code: 'custom', message: 'Provider region is invalid' });
    }
  });

// One provider/credential identity is shared by both optional features. The old
// stores are used only to validate an explicit migration, never at runtime.
export function createAiSettings({ pool, settings, appSecret }) {
  async function read(client = pool) {
    // Metadata and ciphertext are read in the same MVCC snapshot. No second
    // secret read can pair a new credential with an older feature configuration.
    const row = (
      await client.query(
        `SELECT
      COALESCE((SELECT jsonb_object_agg(key,jsonb_build_object('value',value,'revision',updated_at::text))
        FROM app_settings WHERE key=ANY($1::text[])), '{}'::jsonb) AS documents,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('setting',setting,'provider',provider,'ciphertext',ciphertext))
        FROM encrypted_credentials WHERE setting=ANY($2::text[])), '[]'::jsonb) AS credentials`,
        [
          ['ai.provider', ...Object.values(namespaces), ...Object.values(previousNamespaces)],
          ['ai', ...Object.values(previousNamespaces)].flatMap((namespace) =>
            fields.map((field) => `${namespace}.${field}`)
          )
        ]
      )
    ).rows[0];
    return row;
  }

  function secretsFor(raw, namespace, provider) {
    const credentials = {},
      secrets = {};
    for (const field of fields) {
      const setting = `${namespace}.${field}`;
      const row = raw.credentials.find((item) => item.setting === setting && item.provider === provider);
      let unreadable = false;
      if (row) {
        try {
          const value = decryptSecret(row.ciphertext, appSecret, setting, provider);
          if (!value || (field === 'accessKeyId' && value.startsWith('ASIA'))) {
            throw Error('Unsupported credential');
          }

          secrets[field] = value;
        } catch {
          unreadable = true;
        }
      }

      credentials[field] = { configured: !!row, masked: row ? '••••••••' : '', unreadable };
    }

    return {
      credentials,
      secrets,
      configured: required(provider).every((field) => credentials[field].configured),
      credentialsAvailable: required(provider).every((field) => !credentials[field].unreadable)
    };
  }

  function featureValue(input, feature) {
    const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const result = {};
    for (const [field, schema] of Object.entries(schemas[feature].shape)) {
      const parsed = schema.safeParse(source[field]);
      result[field] = parsed.success ? parsed.data : defaults[feature][field];
    }

    if (feature === 'classification' && !Object.hasOwn(source, 'autoClassify') && source.enabled === true) {
      result.autoClassify = true;
    }

    return result;
  }

  function previous(raw) {
    const profiles = [];
    for (const [id, namespace] of Object.entries(previousNamespaces)) {
      const document = raw.documents[namespace];
      if (!document) {
        continue;
      }

      const candidate = { ...document.value };
      if (id === 'classification' && !Object.hasOwn(candidate, 'autoClassify')) {
        candidate.autoClassify = candidate.enabled === true;
      }

      const schema = id === 'classification' ? providerSettingsSchema : assistantSettingsSchema;
      const parsed = schema.safeParse(candidate);
      const valid = parsed.success && !fields.some((field) => Object.hasOwn(candidate, field));
      const value = valid ? parsed.data : { provider: 'openai', model: '', enabled: false };
      // Previous forms could retain an irrelevant AWS region after switching to
      // OpenAI. It never selected an OpenAI destination and is not migrated.
      if (value.provider === 'openai') {
        delete value.region;
      }

      const credentials = secretsFor(raw, namespace, value.provider);
      const meaningful = !!(
        value.model ||
        value.enabled ||
        value.region ||
        fields.some((field) => credentials.credentials[field].configured)
      );
      profiles.push({ id, namespace, value, valid, meaningful, ...credentials });
    }

    const candidates = profiles.filter((profile) => profile.meaningful || !profile.valid);
    const unassociatedCredentials = raw.credentials.some((row) => {
      const entry = Object.entries(previousNamespaces).find(([, namespace]) =>
        fields.some((field) => row.setting === `${namespace}.${field}`)
      );
      if (!entry) {
        return false;
      }

      const profile = profiles.find((item) => item.id === entry[0]);
      return (
        !profile ||
        !profile.valid ||
        row.provider !== profile.value.provider ||
        !required(profile.value.provider).some((field) => row.setting === `${entry[1]}.${field}`)
      );
    });
    let status = 'ready',
      message = null;
    if (unassociatedCredentials) {
      status = 'conflict';
      message =
        'Additional saved AI credentials do not belong to the active profiles. Select a readable profile or enter new shared credentials to explicitly replace the old AI credential sets.';
    } else if (candidates.some((profile) => !profile.valid)) {
      status = 'conflict';
      message = 'Existing AI settings need review. Select a readable profile or enter the shared provider credentials.';
    } else if (candidates.some((profile) => !profile.credentialsAvailable)) {
      status = 'credentials-unavailable';
      message =
        'Existing AI credentials are unavailable. Retired credential formats cannot be recovered by restoring APP_SECRET; re-enter credentials or explicitly select a readable profile. Both AI features are paused.';
    } else if (
      new Set(candidates.map((profile) => JSON.stringify([profile.value.provider, profile.value.region]))).size > 1 ||
      fields.some((field) => new Set(candidates.map((profile) => profile.secrets[field]).filter(Boolean)).size > 1)
    ) {
      status = 'conflict';
      message =
        'Classification and assistant use different provider settings or credentials. Choose which profile both features should use, or enter new shared credentials. Both features are paused until you resolve this.';
    }

    const selected =
      candidates.find((profile) => profile.valid && profile.configured && profile.credentialsAvailable) ||
      candidates.find((profile) => profile.valid) ||
      profiles.find((profile) => profile.valid);
    if (
      status === 'ready' &&
      selected &&
      !selected.configured &&
      candidates.some((profile) => fields.some((field) => profile.credentials[field].configured))
    ) {
      status = 'credentials-unavailable';
      message =
        'Existing AI credentials are incomplete. Re-enter one complete shared credential set; credentials from different profiles are never combined.';
    }

    return {
      profiles,
      selected,
      migration: {
        status,
        message,
        sources: profiles.map((profile) => ({
          id: profile.id,
          provider: profile.value.provider,
          region: profile.value.region,
          configured: profile.valid && profile.configured,
          credentialsAvailable: profile.valid && profile.credentialsAvailable
        }))
      }
    };
  }

  function snapshot(raw, feature) {
    const document = raw.documents['ai.provider'];
    const old = document ? null : previous(raw);
    const parsed = sharedValueSchema.safeParse(document?.value);
    const value = parsed.success ? parsed.data : { provider: 'openai' };
    const settingsAvailable = !!document && parsed.success;
    const secretState = secretsFor(raw, 'ai', value.provider);
    const configured = settingsAvailable && secretState.configured;
    const available = settingsAvailable && secretState.credentialsAvailable;
    const usable = configured && available;
    const discoveryRevision = hash(
      document
        ? [
            document,
            fields.map(
              (field) =>
                raw.credentials.find((row) => row.setting === `ai.${field}` && row.provider === value.provider)
                  ?.ciphertext
            )
          ]
        : [
            Object.entries(previousNamespaces).map(([id, namespace]) => [id, raw.documents[namespace]]),
            raw.credentials
              .filter((row) => !row.setting.startsWith('ai.'))
              .sort((a, b) => `${a.setting}:${a.provider}`.localeCompare(`${b.setting}:${b.provider}`))
          ]
    );
    const migration = old?.migration || { status: 'ready', message: null, sources: [] };
    const disabledReason =
      migration.status !== 'ready'
        ? migration.message
        : !settingsAvailable
          ? 'Shared AI settings are invalid; save a provider and credentials to continue'
          : !secretState.credentialsAvailable
            ? 'Saved AI credentials are unavailable. Re-enter credentials; restoring APP_SECRET does not recover retired formats.'
            : !configured
              ? 'Save shared provider credentials in AI features'
              : null;
    const publicState = {
      ...value,
      configured,
      settingsAvailable,
      credentialsAvailable: secretState.credentialsAvailable,
      encryptionAvailable: canEncrypt(appSecret),
      credentials: secretState.credentials,
      source: 'database',
      discoveryRevision,
      regionCatalog: BEDROCK_REGION_CATALOG,
      migration,
      disabledReason
    };
    const config = {
      ...disabledProviderConfig,
      llmProvider: value.provider,
      llmRegion: value.region,
      llmBaseUrl: value.provider === 'openai' ? 'https://api.openai.com/v1/' : '',
      llmConfigured: configured,
      llmCredentialsUnavailable: !usable,
      llmDisabledReason: disabledReason,
      llmRevision: discoveryRevision
    };
    if (usable) {
      config.llmApiKey = secretState.secrets.apiKey || '';
      config.llmAccessKeyId = secretState.secrets.accessKeyId || '';
      config.llmSecretAccessKey = secretState.secrets.secretAccessKey || '';
    }

    if (!feature) {
      return { value, publicState, config, raw };
    }

    const featureDocument = raw.documents[namespaces[feature]];
    const featureSettings = featureValue(
      featureDocument?.value ?? raw.documents[previousNamespaces[feature]]?.value,
      feature
    );
    const validFeature = !featureDocument || schemas[feature].safeParse(featureDocument.value).success;
    const enabled =
      usable &&
      validFeature &&
      featureSettings.enabled &&
      !!featureSettings.model &&
      (feature !== 'assistant' || featureSettings.dataSharingAcknowledged);
    const reason =
      disabledReason ||
      (!validFeature
        ? 'Stored feature settings are invalid; save valid settings to continue'
        : !featureSettings.model
          ? 'Choose a model before enabling this feature'
          : feature === 'assistant' && !featureSettings.dataSharingAcknowledged
            ? 'Acknowledge provider data sharing before enabling the assistant'
            : !featureSettings.enabled
              ? `${feature === 'assistant' ? 'Assistant' : 'AI classification'} is disabled`
              : null);
    Object.assign(config, {
      llmModel: featureSettings.model,
      llmEnabled: enabled,
      llmConfigured: usable && !!featureSettings.model,
      llmDisabledReason: reason,
      llmRevision: hash([discoveryRevision, feature, featureDocument]),
      llmAutoClassify: feature === 'classification' && enabled && featureSettings.autoClassify,
      llmAutoApply: feature === 'classification' && enabled && featureSettings.autoApply,
      llmDailyRequestLimit: featureSettings.dailyRequestLimit ?? 20,
      llmBatchSize: featureSettings.batchSize ?? 5
    });
    if (feature === 'assistant') {
      Object.assign(config, {
        assistantEnabled: enabled,
        assistantDataSharingAcknowledged: featureSettings.dataSharingAcknowledged,
        assistantDailyRequestLimit: featureSettings.dailyRequestsPerUser,
        assistantMaxToolCalls: featureSettings.maxToolCalls,
        assistantMaxRounds: featureSettings.maxRounds,
        assistantMaxOutputTokens: featureSettings.maxOutputTokens
      });
    }

    return {
      value: { ...value, ...featureSettings },
      config,
      raw,
      publicState: {
        ...publicState,
        ...featureSettings,
        configured: configured && !!featureSettings.model,
        effectiveEnabled: enabled,
        aiRevision: discoveryRevision,
        settingsAvailable: settingsAvailable && validFeature,
        disabledReason: reason,
        ...(feature === 'assistant' ? { disclosure: assistantDisclosure } : {})
      }
    };
  }

  async function atomic(action) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Shared with the vault and classification result commit. A connection
      // change cannot race either feature metadata or an applied classification.
      await client.query('SELECT pg_advisory_xact_lock(17092381)');
      const result = await action(client, await read(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function discardPrevious(client) {
    await client.query('DELETE FROM encrypted_credentials WHERE setting=ANY($1::text[])', [
      Object.values(previousNamespaces).flatMap((namespace) => fields.map((field) => `${namespace}.${field}`))
    ]);
    await client.query('DELETE FROM app_settings WHERE key=ANY($1::text[])', [Object.values(previousNamespaces)]);
  }

  async function writeFeatures(client, raw, { provider, pause = false } = {}) {
    for (const feature of Object.keys(namespaces)) {
      const prior = raw.documents[namespaces[feature]]?.value ?? raw.documents[previousNamespaces[feature]]?.value;
      const value = featureValue(prior, feature);
      const oldProvider = raw.documents['ai.provider']?.value?.provider ?? prior?.provider;
      if (oldProvider && oldProvider !== provider) {
        value.model = '';
        if (feature === 'assistant') {
          value.dataSharingAcknowledged = false;
        }
      }

      if (pause || !value.model) {
        value.enabled = false;
      }

      await settings.setValue(namespaces[feature], value, client);
    }
  }

  async function initialize() {
    await settings.init();
    return atomic(async (client, raw) => {
      if (raw.documents['ai.provider']) {
        return;
      }

      const old = previous(raw);
      if (old.migration.status !== 'ready') {
        return;
      }

      const value = old.selected
        ? {
            provider: old.selected.value.provider,
            ...(old.selected.value.region ? { region: old.selected.value.region } : {})
          }
        : { provider: 'openai' };
      for (const field of required(value.provider)) {
        if (old.selected?.secrets[field]) {
          await settings.setSecret(`ai.${field}`, value.provider, old.selected.secrets[field], client);
        }
      }

      await writeFeatures(client, raw, { provider: value.provider, pause: !old.selected?.configured });
      await settings.setValue('ai.provider', value, client);
      await discardPrevious(client);
    });
  }

  async function getProviderSnapshot(client = pool) {
    return snapshot(await read(client));
  }

  async function save(input) {
    const parsed = sharedAiSettingsSchema.safeParse(input);
    if (!parsed.success) {
      throw failure('Invalid shared AI settings', 400);
    }

    const value = parsed.data;
    return atomic(async (client, raw) => {
      const before = snapshot(raw);
      if (before.publicState.discoveryRevision !== value.revision) {
        throw failure('Shared AI settings changed. Reload the connection before saving.');
      }

      const old = raw.documents['ai.provider'] ? null : previous(raw);
      let reused;
      if (value.reuseCredentialsFrom) {
        reused = old?.profiles.find((profile) => profile.id === value.reuseCredentialsFrom);
        if (
          !reused?.valid ||
          !reused.configured ||
          !reused.credentialsAvailable ||
          reused.value.provider !== value.provider ||
          reused.value.region !== value.region
        ) {
          throw failure(
            'The selected profile is unavailable or does not match the provider and region. Re-enter credentials.'
          );
        }
      }

      const resetting = required(value.provider).every((field) => value[field] === null);
      if (
        old &&
        old.migration.status !== 'ready' &&
        !reused &&
        !resetting &&
        !required(value.provider).every((field) => typeof value[field] === 'string' && value[field])
      ) {
        throw failure(
          'Resolve the existing AI credential conflict by selecting a readable profile, entering all required credentials, or explicitly clearing all required credentials.'
        );
      }

      const changed =
        !raw.documents['ai.provider'] ||
        before.value.provider !== value.provider ||
        before.value.region !== value.region ||
        !!reused ||
        fields.some((field) => value[field] !== undefined);
      if (before.value.provider !== value.provider) {
        await client.query('DELETE FROM encrypted_credentials WHERE setting=ANY($1::text[])', [
          fields.map((field) => `ai.${field}`)
        ]);
      }

      for (const field of required(value.provider)) {
        const secret = reused ? reused.secrets[field] : value[field];
        if (secret !== undefined) {
          await settings.setSecret(`ai.${field}`, value.provider, secret, client);
        }
      }

      const publicValue = { provider: value.provider, ...(value.region ? { region: value.region } : {}) };
      await writeFeatures(client, raw, { provider: value.provider, pause: changed });
      await settings.setValue('ai.provider', publicValue, client);
      await discardPrevious(client);
      return snapshot(await read(client)).publicState;
    });
  }

  async function saveFeature(feature, input) {
    const parsed = schemas[feature].extend({ aiRevision: revisionSchema }).safeParse(input);
    if (
      !parsed.success ||
      (parsed.data.enabled && (!parsed.data.model || (feature === 'assistant' && !parsed.data.dataSharingAcknowledged)))
    ) {
      throw failure('Choose a model and valid feature settings before enabling', 400);
    }

    const { aiRevision, ...value } = parsed.data;
    return atomic(async (client, raw) => {
      const shared = snapshot(raw);
      if (shared.publicState.discoveryRevision !== aiRevision) {
        throw failure('Shared AI settings changed. Review the new connection and reload this feature before saving.');
      }

      if (!shared.publicState.settingsAvailable || shared.publicState.migration.status !== 'ready') {
        throw failure('Configure the shared AI connection before saving feature settings.');
      }

      if (value.enabled && (!shared.publicState.configured || !shared.publicState.credentialsAvailable)) {
        throw failure('Save usable shared provider credentials before enabling AI features.');
      }

      await settings.setValue(namespaces[feature], value, client);
      return snapshot(await read(client), feature).publicState;
    });
  }

  const classification = {
    getPublicProvider: async () => snapshot(await read(), 'classification').publicState,
    getProviderSnapshot: async (client = pool) => snapshot(await read(client), 'classification'),
    getProviderConfig: async (client = pool) => snapshot(await read(client), 'classification').config,
    saveProvider: (input) => saveFeature('classification', input)
  };
  const assistant = {
    getPublic: async () => snapshot(await read(), 'assistant').publicState,
    getProviderSnapshot: async (client = pool) => snapshot(await read(client), 'assistant'),
    getRuntimeConfig: async (client = pool) => snapshot(await read(client), 'assistant').config,
    getProviderConfig: async (client = pool) => snapshot(await read(client), 'assistant').config,
    save: (input) => saveFeature('assistant', input),
    getUserStatus: async () => {
      const state = snapshot(await read(), 'assistant').publicState;
      return {
        enabled: state.effectiveEnabled,
        configured: state.configured,
        provider: state.provider,
        model: state.model,
        disabledReason: state.disabledReason,
        disclosure: assistantDisclosure
      };
    }
  };
  return {
    init: initialize,
    getPublic: async () => (await getProviderSnapshot()).publicState,
    save,
    getProviderSnapshot,
    getProviderConfig: async (client = pool) => (await getProviderSnapshot(client)).config,
    classification,
    assistant
  };
}
