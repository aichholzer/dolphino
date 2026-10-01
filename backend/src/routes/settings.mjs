import { z } from 'zod';
import { testProviderConnection, testProviderModel } from '../llm.js';
import { testAssistantModel } from '../assistant-provider-test.js';
import { FINANCE_TOOLS } from '../assistant-tools.js';
import { body } from '../http/body.mjs';

export function registerSettingsRoutes({
  route,
  config,
  integration,
  settings,
  redbarkSettings,
  assistantSettings,
  providerDependencies,
  sensitive
}) {
  route('get', '/api/settings/assistant', async () => ({
    ...(await assistantSettings.getPublic()),
    tools: FINANCE_TOOLS,
    readOnly: true
  }));

  route('put', '/api/settings/assistant', async (req) => {
    sensitive('assistant-settings');
    return assistantSettings.save(await body(req));
  });

  route('post', '/api/settings/assistant/test-connection', async () => {
    sensitive('assistant-connection-test');
    return testProviderConnection(await assistantSettings.getRuntimeConfig(), providerDependencies);
  });

  route('post', '/api/settings/assistant/test-model', async (req) => {
    sensitive('assistant-model-test');
    z.object({ acknowledgeCost: z.literal(true) })
      .strict()
      .parse(await body(req));
    return testAssistantModel(await assistantSettings.getRuntimeConfig(), providerDependencies);
  });

  route('get', '/api/settings', async () => ({
    mode: config.mode,
    currency: config.currency,
    timeZone: config.timezone,
    redbark: await integration.status(),
    llm: settings
      ? await settings.getPublicProvider()
      : {
          enabled: false,
          configured: false,
          autoClassify: false,
          autoApply: false,
          dailyRequestLimit: 20,
          batchSize: 5,
          source: 'database'
        }
  }));

  route('get', '/api/settings/redbark', () => redbarkSettings.getPublic());

  route('put', '/api/settings/redbark', async (req) => {
    sensitive('save-redbark');
    return redbarkSettings.save(await body(req));
  });

  route('get', '/api/settings/provider', () => settings.getPublicProvider());

  route('put', '/api/settings/provider', async (req) => {
    sensitive('save-provider');
    return settings.saveProvider(await body(req));
  });

  route('post', '/api/settings/provider/test-connection', async () => {
    sensitive('provider-test');
    return testProviderConnection(await settings.getProviderConfig(), providerDependencies);
  });

  route('post', '/api/settings/provider/test-model', async (req) => {
    sensitive('model-test');
    z.object({ acknowledgeCost: z.literal(true) })
      .strict()
      .parse(await body(req));
    return testProviderModel(await settings.getProviderConfig(), providerDependencies);
  });
}
