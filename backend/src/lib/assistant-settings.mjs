import { z } from 'zod';
import { createSettingsStore, providerSettingsSchema } from './settings.mjs';
const p = providerSettingsSchema.shape;
export const assistantSettingsSchema = z
  .object({
    provider: p.provider,
    model: p.model,
    region: p.region,
    apiKey: p.apiKey,
    accessKeyId: p.accessKeyId,
    secretAccessKey: p.secretAccessKey,
    enabled: z.boolean().default(false),
    dataSharingAcknowledged: z.boolean().default(false),
    dailyRequestsPerUser: z.number().int().min(1).max(100).default(10),
    maxToolCalls: z.number().int().min(1).max(8).default(4),
    maxRounds: z.number().int().min(1).max(4).default(3),
    maxOutputTokens: z.number().int().min(128).max(2048).default(1024)
  })
  .strict()
  .superRefine((v, ctx) => {
    if (!v.model && (v.provider !== 'bedrock' || v.enabled)) {
      ctx.addIssue({ code: 'custom', message: 'Choose a model before enabling', path: ['model'] });
    }

    if (v.provider === 'bedrock' && !v.region) {
      ctx.addIssue({
        code: 'custom',
        message: 'AWS region is required',
        path: ['region']
      });
    }

    if (v.provider === 'bedrock' && v.accessKeyId?.startsWith('ASIA')) {
      ctx.addIssue({
        code: 'custom',
        message: 'Temporary AWS credentials are not supported',
        path: ['accessKeyId']
      });
    }

    if (v.enabled && !v.dataSharingAcknowledged) {
      ctx.addIssue({
        code: 'custom',
        message: 'Acknowledge provider data sharing before enabling the assistant',
        path: ['dataSharingAcknowledged']
      });
    }
  });

const defaults = {
  enabled: false,
  dataSharingAcknowledged: false,
  dailyRequestsPerUser: 10,
  maxToolCalls: 4,
  maxRounds: 3,
  maxOutputTokens: 1024
};
export const assistantDisclosure =
  'When enabled, your questions and retrieved financial data you are permitted to access, including transaction descriptions, notes and account/budget summaries, may be sent to the selected AI provider. Do not enter credentials or other secrets. Provider retention and logging policies apply; OpenAI store:false does not guarantee zero retention. The assistant is read-only and cannot change records, grants or settings.';

export function createAssistantSettings({ pool, appSecret }) {
  const store = createSettingsStore({
    pool,
    appSecret,
    providerNamespace: 'assistant.llm',
    settingsSchema: assistantSettingsSchema,
    defaultSettings: { provider: 'openai', model: '', ...defaults }
  });
  async function getPublic() {
    const value = await store.getPublicProvider();
    const state = { ...defaults, ...value };
    delete state.autoClassify;
    delete state.autoApply;
    delete state.dailyRequestLimit;
    delete state.batchSize;
    state.enabled = state.enabled === true;
    state.disabledReason = !state.configured
      ? 'Configure the separate assistant provider and credentials'
      : !state.credentialsAvailable
        ? 'Assistant credentials unavailable; verify APP_SECRET or replace credentials'
        : !state.dataSharingAcknowledged
          ? 'Acknowledge provider data sharing before enabling the assistant'
          : !state.enabled
            ? 'Assistant is disabled'
            : null;
    state.disclosure = assistantDisclosure;
    state.source = 'database';
    return state;
  }

  async function getRuntimeConfig() {
    const snapshot = await store.getProviderSnapshot();
    const runtime = snapshot.config;
    const value = { ...defaults, ...snapshot.value };
    const enabled =
      value.enabled === true &&
      value.dataSharingAcknowledged === true &&
      runtime.llmEnabled === true &&
      !runtime.llmCredentialsUnavailable;
    return {
      ...runtime,
      llmEnabled: enabled,
      llmAutoClassify: false,
      llmAutoApply: false,
      assistantEnabled: enabled,
      assistantDataSharingAcknowledged: value.dataSharingAcknowledged,
      assistantDailyRequestLimit: value.dailyRequestsPerUser,
      assistantMaxToolCalls: value.maxToolCalls,
      assistantMaxRounds: value.maxRounds,
      assistantMaxOutputTokens: value.maxOutputTokens
    };
  }

  async function save(input) {
    await store.saveProvider(input);
    return getPublic();
  }

  async function getUserStatus() {
    const value = await getPublic();
    return {
      enabled: value.enabled && value.dataSharingAcknowledged && value.configured && value.credentialsAvailable,
      provider: value.provider,
      model: value.model,
      configured: value.configured,
      disabledReason: value.disabledReason,
      disclosure: assistantDisclosure
    };
  }

  return {
    init: store.init,
    getPublic,
    save,
    getRuntimeConfig,
    getProviderConfig: getRuntimeConfig,
    getProviderSnapshot: store.getProviderSnapshot,
    getUserStatus
  };
}
