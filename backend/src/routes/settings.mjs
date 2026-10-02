import { z } from 'zod';
import { testProviderConnection, testProviderModel } from '../lib/llm.mjs';
import { testAssistantModel } from '../lib/assistant-provider-test.mjs';
import { FINANCE_TOOLS } from '../lib/assistant-tools.mjs';
import { body } from '../http/body.mjs';
import { discoverSavedBedrockModels } from '../lib/bedrock-models.mjs';

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
  for (const namespace of ['provider', 'assistant']) {
    route('post', `/api/settings/${namespace}/models`, async (req, res) => {
      sensitive('bedrock-model-discovery');
      const { revision } = z
        .object({ revision: z.string().regex(/^[a-f0-9]{64}$/) })
        .strict()
        .parse(await body(req));
      const cancel = new AbortController();
      const disconnected = () => {
        if (!res.writableEnded) {
          cancel.abort();
        }
      };

      req.once('aborted', disconnected);
      res.once('close', disconnected);
      try {
        const source = namespace === 'provider' ? settings : assistantSettings;
        return await discoverSavedBedrockModels(() => source.getProviderSnapshot(), revision, {
          ...providerDependencies,
          signal: cancel.signal
        });
      } finally {
        req.off('aborted', disconnected);
        res.off('close', disconnected);
      }
    });
  }

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
