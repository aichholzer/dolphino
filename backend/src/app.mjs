import rayo from 'rayo';
import { createSimplefinIntegration } from './lib/simplefin.mjs';
import { createHouseholdAuth } from './lib/household-auth.mjs';
import { createSecurityHeaders, createSensitiveActionGuard } from './http/security.mjs';
import { createStaticHandler } from './http/static.mjs';
import { createRouteRegistrar } from './http/router.mjs';
import { send } from './http/response.mjs';
import { createFinanceQueries } from './routes/finance-queries.mjs';
import { registerAuthRoutes } from './routes/auth.mjs';
import { registerUserRoutes } from './routes/users.mjs';
import { registerAssistantRoutes } from './routes/assistant.mjs';
import { registerSettingsRoutes } from './routes/settings.mjs';
import { registerIntegrationRoutes } from './routes/integrations.mjs';
import { registerNotificationRoutes } from './routes/notifications.mjs';
import { registerAccountRoutes } from './routes/accounts.mjs';
import { registerTransactionRoutes } from './routes/transactions.mjs';
import { registerBudgetRoutes } from './routes/budgets.mjs';
import { registerReviewRoutes } from './routes/reviews.mjs';
import { registerRuleRoutes } from './routes/rules.mjs';
import { registerReportRoutes } from './routes/reports.mjs';

// Keep the public body parser export for existing consumers.
export { body } from './http/body.mjs';

export function createApp({
  store,
  integration,
  classification,
  config,
  settings,
  redbarkSettings,
  simplefin = settings ? createSimplefinIntegration({ pool: store.pool, store, settings, config }) : null,
  registration,
  providerDependencies,
  notifications,
  telegram,
  importHealth,
  auth = createHouseholdAuth({ pool: store.pool, config }),
  users,
  assistant,
  assistantSettings,
  aiSettings
}) {
  settings = aiSettings ? { ...settings, ...aiSettings.classification } : settings;
  assistantSettings = aiSettings?.assistant ?? assistantSettings;
  const securityHeaders = createSecurityHeaders(config);
  const app = rayo({
    host: config.host,
    port: config.port,
    notFound: createStaticHandler(securityHeaders),
    onError: (_error, _req, res) => {
      securityHeaders(res);
      send(res, { error: 'Request failed' }, 500);
    }
  });
  const route = createRouteRegistrar({ app, store, auth, config, securityHeaders });
  const sensitive = createSensitiveActionGuard(config);
  const { ledger, filters, report } = createFinanceQueries({ config });

  registerAuthRoutes({ route, store, auth, users, sensitive, config });
  registerUserRoutes({ route, users, sensitive });
  registerAssistantRoutes({ route, store, auth, assistant, assistantSettings, config });
  registerSettingsRoutes({
    aiSettings,
    route,
    config,
    integration,
    settings,
    redbarkSettings,
    assistantSettings,
    providerDependencies,
    sensitive
  });
  registerIntegrationRoutes({ route, integration, registration, simplefin, importHealth, sensitive });
  registerNotificationRoutes({ route, notifications, telegram, sensitive });
  registerAccountRoutes({ route, ledger });
  registerTransactionRoutes({ route, store, classification, ledger, filters });
  registerBudgetRoutes({ route, ledger, report });
  registerReviewRoutes({ route, ledger });
  registerRuleRoutes({ route, store });
  registerReportRoutes({ route, ledger, filters, report, config });
  return app;
}
