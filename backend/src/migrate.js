import pg from "pg";
import { ensureDeploymentMode } from "./deployment-mode.js";
import { createAssistantSettings } from "./assistant-settings.js";
import { createAssistantUsage } from "./assistant-usage.js";
import { createHouseholdAuth } from "./household-auth.js";
import { createUserManagement } from "./users.js";
import { ensureAccessSchema } from "./access.js";
import { createNotificationIntegration } from "./notifications.js";
import { createSettingsStore } from "./settings.js";
import { createRegistration } from "./registration.js";
import { readConfig } from "./config.js";
import { createClassificationIntegration } from "./classification.js";
import { Store } from "./store.js";
import { ensureRedbarkSchema } from "./worker.js";
const config = readConfig();
const pool = new pg.Pool({ connectionString: config.databaseUrl });
try {
  await ensureDeploymentMode(pool, config.mode);
  await new Store(pool, {
    mode: config.mode,
    timezone: config.timezone,
  }).migrate();
  await ensureRedbarkSchema(pool);
  await createClassificationIntegration({ pool, store: null, config }).init();
  const settings = createSettingsStore({
    pool,
    appSecret: config.appSecret,
  });
  await settings.init();
  await createRegistration({ pool, settings, config }).init();
  await createNotificationIntegration({
    pool,
    settings,
    mode: config.mode,
  }).init();
  await createHouseholdAuth({ pool, config }).init();
  await ensureAccessSchema(pool);
  await createUserManagement({ pool, config, settings }).init();
  await createAssistantSettings({ pool, appSecret: config.appSecret }).init();
  await createAssistantUsage({ pool }).init();
  console.log("Migrations complete");
} finally {
  await pool.end();
}
