import { createSimplefinIntegration } from './lib/simplefin.mjs';
import { createPocketSmithIntegration } from './lib/pocketsmith.mjs';
import pg from 'pg';
import { ensureDeploymentMode } from './lib/deployment-mode.mjs';
import { createAiSettings } from './lib/ai-settings.mjs';
import { createAssistantUsage } from './lib/assistant-usage.mjs';
import { createAssistant } from './lib/assistant.mjs';
import { sendAssistantTurn } from './lib/assistant-provider.mjs';
import { FINANCE_TOOLS, invokeFinanceTool } from './lib/assistant-tools.mjs';
import { createHouseholdAuth } from './lib/household-auth.mjs';
import { createUserManagement } from './lib/users.mjs';
import { ensureAccessSchema } from './lib/access.mjs';
import { createNotificationIntegration } from './lib/notifications.mjs';
import { createTelegramPairing, sendTelegram } from './lib/telegram.mjs';
import { createImportHealth } from './lib/import-health.mjs';
import { readConfig } from './lib/config.mjs';
import { Store } from './lib/store.mjs';
import { createRedbarkIntegration } from './lib/worker.mjs';
import { createClassificationIntegration } from './lib/classification.mjs';
import { createSettingsStore } from './lib/settings.mjs';
import { createRedbarkSettings } from './lib/redbark-settings.mjs';
import { createRegistration } from './lib/registration.mjs';
import { createApp } from './app.mjs';
const config = readConfig();
const pool = new pg.Pool({
  ...config.database,
  max: 10,
  connectionTimeoutMillis: 5000
});
pool.on('error', () => console.error('Database connection unavailable'));
await ensureDeploymentMode(pool, config.mode);
const store = new Store(pool, { mode: config.mode, timezone: config.timezone });
await store.migrate();
const credentialStore = createSettingsStore({
  pool,
  appSecret: config.appSecret
});
await credentialStore.init();
const aiSettings = createAiSettings({ pool, settings: credentialStore, appSecret: config.appSecret });
await aiSettings.init();
const settings = { ...credentialStore, ...aiSettings.classification };
const assistantSettings = aiSettings.assistant;
const redbarkSettings = createRedbarkSettings({
  pool,
  settings,
  appSecret: config.appSecret
});
const registration = createRegistration({
  pool,
  settings,
  config,
  getRedbarkConfig: redbarkSettings.getRuntimeConfig
});
await registration.init();
const integration = createRedbarkIntegration({
  pool,
  store,
  config,
  getRedbarkConfig: redbarkSettings.getRuntimeConfig
});
await integration.init();
const simplefin = createSimplefinIntegration({ pool, store, settings, config });
const pocketsmith = createPocketSmithIntegration({ pool, store, settings, config });
await simplefin.init();
const classification = createClassificationIntegration({
  pool,
  store,
  config,
  getProviderConfig: settings.getProviderConfig
});
await classification.init();
const notifications = createNotificationIntegration({
  pool,
  settings,
  mode: config.mode,
  sendTelegram
});
await notifications.init();
const telegram = createTelegramPairing({ pool, settings });
await telegram.init();
const importHealth = createImportHealth({ pool, store, config, integration });
const auth = createHouseholdAuth({ pool, config });
await auth.init();
await ensureAccessSchema(pool);
const users = createUserManagement({ pool, config, settings });
await users.init();
const assistantUsage = createAssistantUsage({ pool });
await assistantUsage.init();
const assistant = createAssistant({
  getProviderConfig: async () => ({
    ...(await assistantSettings.getRuntimeConfig()),
    timezone: config.timezone
  }),
  reserveRequest: assistantUsage.reserveRequest,
  sendTurn: sendAssistantTurn,
  invokeTool: invokeFinanceTool,
  tools: FINANCE_TOOLS
});
const app = createApp({
  aiSettings,
  assistant,
  assistantSettings,
  auth,
  users,
  store,
  integration,
  classification,
  config,
  settings,
  redbarkSettings,
  simplefin,
  pocketsmith,
  registration,
  notifications,
  telegram,
  importHealth
});
const server = app.start(() => console.log(`dolphino ${config.mode} listening on port ${config.port}`));
integration.start();
simplefin.start();
pocketsmith.start();
classification.start();
if (config.mode === 'live') {
  notifications.start();
}

let closing = false;
async function close() {
  if (closing) {
    return;
  }

  closing = true;
  await integration.stop();
  await simplefin.stop();
  await pocketsmith.stop();
  classification.stop();
  await notifications.stop();
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGTERM', close);
process.on('SIGINT', close);
