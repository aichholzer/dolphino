import pg from "pg";
import { ensureDeploymentMode } from "./deployment-mode.js";
import { createAssistantSettings } from "./assistant-settings.js";
import { createAssistantUsage } from "./assistant-usage.js";
import { createAssistant } from "./assistant.js";
import { sendAssistantTurn } from "./assistant-provider.js";
import { FINANCE_TOOLS, invokeFinanceTool } from "./assistant-tools.js";
import { createHouseholdAuth } from "./household-auth.js";
import { createUserManagement } from "./users.js";
import { ensureAccessSchema } from "./access.js";
import { createNotificationIntegration } from "./notifications.js";
import { createTelegramPairing, sendTelegram } from "./telegram.js";
import { createImportHealth } from "./import-health.js";
import { readConfig } from "./config.js";
import { Store } from "./store.js";
import { createRedbarkIntegration } from "./worker.js";
import { createClassificationIntegration } from "./classification.js";
import { createSettingsStore } from "./settings.js";
import { createRegistration } from "./registration.js";
import { createApp } from "./app.js";
const config = readConfig();
const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 10,
  connectionTimeoutMillis: 5000,
});
pool.on("error", () => console.error("Database connection unavailable"));
await ensureDeploymentMode(pool, config.mode);
const store = new Store(pool, { mode: config.mode, timezone: config.timezone });
await store.migrate();
const settings = createSettingsStore({
  pool,
  appSecret: config.appSecret,
  envConfig: config,
});
await settings.init();
const registration = createRegistration({ pool, settings, config });
await registration.init();
const integration = createRedbarkIntegration({
  pool,
  store,
  config,
  getWebhookSecret: registration.runtimeSigningSecret,
});
await integration.init();
const classification = createClassificationIntegration({
  pool,
  store,
  config,
  getProviderConfig: settings.getProviderConfig,
});
await classification.init();
const notifications = createNotificationIntegration({
  pool,
  settings,
  mode: config.mode,
  sendTelegram,
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
const assistantSettings = createAssistantSettings({
  pool,
  appSecret: config.appSecret,
});
await assistantSettings.init();
const assistantUsage = createAssistantUsage({ pool });
await assistantUsage.init();
const assistant = createAssistant({
  getProviderConfig: async () => ({
    ...(await assistantSettings.getRuntimeConfig()),
    timezone: config.timezone,
  }),
  reserveRequest: assistantUsage.reserveRequest,
  sendTurn: sendAssistantTurn,
  invokeTool: invokeFinanceTool,
  tools: FINANCE_TOOLS,
});
const app = createApp({
  assistant,
  assistantSettings,
  auth,
  users,
  store,
  integration,
  classification,
  config,
  settings,
  registration,
  notifications,
  telegram,
  importHealth,
});
const server = app.start(() =>
  console.log(`Profe ${config.mode} listening on port ${config.port}`),
);
integration.start();
classification.start();
if (config.mode === "live") notifications.start();
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await integration.stop();
  classification.stop();
  await notifications.stop();
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on("SIGTERM", close);
process.on("SIGINT", close);
