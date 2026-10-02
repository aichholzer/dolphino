import pg from 'pg';
import { ensureDeploymentMode } from '../lib/deployment-mode.mjs';
import { createAiSettings } from '../lib/ai-settings.mjs';
import { createAssistantUsage } from '../lib/assistant-usage.mjs';
import { createHouseholdAuth } from '../lib/household-auth.mjs';
import { createUserManagement } from '../lib/users.mjs';
import { ensureAccessSchema } from '../lib/access.mjs';
import { createNotificationIntegration } from '../lib/notifications.mjs';
import { createSettingsStore } from '../lib/settings.mjs';
import { createRegistration } from '../lib/registration.mjs';
import { readConfig } from '../lib/config.mjs';
import { createClassificationIntegration } from '../lib/classification.mjs';
import { Store } from '../lib/store.mjs';
import { ensureRedbarkSchema } from '../lib/worker.mjs';
const config = readConfig();
const pool = new pg.Pool(config.database);
try {
  await ensureDeploymentMode(pool, config.mode);
  await new Store(pool, {
    mode: config.mode,
    timezone: config.timezone
  }).migrate();
  await ensureRedbarkSchema(pool);
  await createClassificationIntegration({ pool, store: null, config }).init();
  const settings = createSettingsStore({
    pool,
    appSecret: config.appSecret
  });
  await settings.init();
  await createRegistration({ pool, settings, config }).init();
  await createNotificationIntegration({
    pool,
    settings,
    mode: config.mode
  }).init();
  await createHouseholdAuth({ pool, config }).init();
  await ensureAccessSchema(pool);
  await createUserManagement({ pool, config, settings }).init();
  await createAiSettings({ pool, settings, appSecret: config.appSecret }).init();
  await createAssistantUsage({ pool }).init();
  console.log('Migrations complete');
} finally {
  await pool.end();
}
