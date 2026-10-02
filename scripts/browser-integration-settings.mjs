import { readTestPostgresConfig } from '../backend/test/helpers/postgres.mjs';
import { installBrowserStorageGuard } from '../frontend/test/browser-storage-guard.mjs';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import pg from 'pg';
import { chromium, expect } from '@playwright/test';
import { ListFoundationModelsCommand, ListInferenceProfilesCommand } from '@aws-sdk/client-bedrock';
import { Store } from '../backend/src/lib/store.mjs';
import { createApp } from '../backend/src/app.mjs';
import { ensureDeploymentMode } from '../backend/src/lib/deployment-mode.mjs';
import { createHouseholdAuth } from '../backend/src/lib/household-auth.mjs';
import { ensureAccessSchema, validateAndSetGrants } from '../backend/src/lib/access.mjs';
import { createSettingsStore } from '../backend/src/lib/settings.mjs';
import { createRedbarkSettings } from '../backend/src/lib/redbark-settings.mjs';
import { createRedbarkIntegration } from '../backend/src/lib/worker.mjs';
import { createRegistration } from '../backend/src/lib/registration.mjs';
import { createClassificationIntegration } from '../backend/src/lib/classification.mjs';
import { createAssistantSettings } from '../backend/src/lib/assistant-settings.mjs';
import { createNotificationIntegration } from '../backend/src/lib/notifications.mjs';
import { createTelegramPairing } from '../backend/src/lib/telegram.mjs';
import { createImportHealth } from '../backend/src/lib/import-health.mjs';
import { createUserManagement } from '../backend/src/lib/users.mjs';

// Real compiled frontend + HTTP createApp + isolated PostgreSQL schema. Only
// outbound provider transports are injected. No /api response is intercepted.
const database = readTestPostgresConfig();
assert(
  database,
  'Set PGHOST, PGDATABASE, PGUSER (or TEST_DATABASE_URL) for a disposable PostgreSQL database; see docs/verification.md.'
);
const owner = new pg.Pool(database);
const schema = `browser_settings_${randomUUID().replaceAll('-', '')}`;
await owner.query(`CREATE SCHEMA ${schema}`);
const pool = new pg.Pool({
  ...database,
  options: `-c search_path=${schema}`
});
const key = 'synthetic-browser-redbark-key-A';
const nextKey = 'synthetic-browser-redbark-key-B';
const signingSecret = 'synthetic-browser-signing-secret';
const openaiKey = 'synthetic-browser-openai-key';
const errors = [],
  external = [],
  requests = [],
  evidence = [];
let server, browser, base;
let providerCalls = 0,
  bedrockDiscoveryCalls = 0,
  redbarkCalls = 0;
const forbiddenOutbound = async () => {
  throw Error('Unexpected outbound provider operation in isolated browser fixture');
};

const config = {
  mode: 'live',
  host: '127.0.0.1',
  port: 0,
  origin: 'https://synthetic.invalid',
  currency: 'AUD',
  timezone: 'Australia/Brisbane',
  bootstrapToken: randomBytes(32).toString('base64'),
  appSecret: randomBytes(32).toString('base64')
};
const screenshots = process.env.DOLPHINO_SCREENSHOT_DIR || 'artifacts';
const proof = (message) => {
  evidence.push(message);
  console.log(`PASS ${message}`);
};

try {
  await ensureDeploymentMode(pool, 'live');
  const store = new Store(pool, { mode: 'live', timezone: config.timezone });
  await store.migrate();
  const settings = createSettingsStore({ pool, appSecret: config.appSecret });
  await settings.init();
  const redbarkSettings = createRedbarkSettings({
    pool,
    settings,
    appSecret: config.appSecret
  });
  const integration = createRedbarkIntegration({
    pool,
    store,
    config,
    getRedbarkConfig: redbarkSettings.getRuntimeConfig,
    fetchImpl: async (url) => {
      assert.equal(new URL(url).pathname, '/v2/accounts');
      redbarkCalls++;
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }
  });
  await integration.init();
  const registration = createRegistration({
    pool,
    settings,
    config,
    getRedbarkConfig: redbarkSettings.getRuntimeConfig,
    client: { request: forbiddenOutbound },
    lookupImpl: forbiddenOutbound
  });
  await registration.init();
  const classification = createClassificationIntegration({
    pool,
    store,
    config,
    getProviderConfig: settings.getProviderConfig,
    fetchImpl: forbiddenOutbound
  });
  await classification.init();
  const assistantSettings = createAssistantSettings({
    pool,
    appSecret: config.appSecret
  });
  await assistantSettings.init();
  const notifications = createNotificationIntegration({
    pool,
    settings,
    mode: 'live',
    sendTelegram: forbiddenOutbound,
    sendSmtpImpl: forbiddenOutbound
  });
  await notifications.init();
  const telegram = createTelegramPairing({
    pool,
    settings,
    fetchImpl: forbiddenOutbound
  });
  await telegram.init();
  const importHealth = createImportHealth({ pool, store, config, integration });
  const auth = createHouseholdAuth({ pool, config });
  await auth.init();
  await ensureAccessSchema(pool);
  const users = createUserManagement({
    pool,
    config,
    settings,
    sendMail: forbiddenOutbound
  });
  await users.init();
  const admin = await auth.bootstrap(
    { headers: {}, socket: { remoteAddress: 'synthetic-browser-fixture' } },
    {
      email: 'synthetic-admin@example.com',
      name: 'Synthetic admin',
      password: 'synthetic browser password',
      bootstrapToken: config.bootstrapToken
    }
  );
  const memberId = (
    await pool.query(
      "INSERT INTO household_users(email,name,role,password_hash) SELECT 'synthetic-member@example.com','Synthetic member','member',password_hash FROM household_users WHERE id=$1 RETURNING id",
      [admin.user.id]
    )
  ).rows[0].id;
  const member = await auth.login(
    { headers: {}, socket: { remoteAddress: 'synthetic-browser-fixture' } },
    {
      email: 'synthetic-member@example.com',
      password: 'synthetic browser password'
    }
  );
  const transaction = await store.ingest({
    sourceId: 'synthetic-browser-transaction',
    accountId: 'synthetic-browser-account',
    currency: 'AUD',
    amountMinor: '-100',
    date: new Date().toISOString().slice(0, 10),
    status: 'posted',
    kind: 'expense',
    category: 'Uncategorized',
    description: 'Synthetic browser grocery purchase'
  });
  await store.atomic(
    (client) =>
      validateAndSetGrants(
        client,
        memberId,
        {
          accounts: [{ accountId: 'synthetic-browser-account', access: 'view' }]
        },
        { mode: 'live' }
      ),
    { refresh: false }
  );
  const app = createApp({
    store,
    config,
    auth,
    users,
    settings,
    redbarkSettings,
    integration,
    registration,
    classification,
    assistantSettings,
    notifications,
    telegram,
    importHealth,
    providerDependencies: {
      bedrockControlClient: {
        send: async (command) => {
          bedrockDiscoveryCalls++;
          if (command instanceof ListFoundationModelsCommand) {
            return {
              modelSummaries: [
                {
                  modelId: 'synthetic.bedrock-model',
                  modelName: 'Synthetic Bedrock model',
                  providerName: 'Synthetic',
                  inputModalities: ['TEXT'],
                  outputModalities: ['TEXT'],
                  inferenceTypesSupported: ['ON_DEMAND'],
                  modelLifecycle: { status: 'ACTIVE' }
                }
              ]
            };
          }

          assert(
            command instanceof ListInferenceProfilesCommand,
            'Discovery must not invoke AWS or accept model agreements'
          );
          return { inferenceProfileSummaries: [] };
        }
      },
      fetchImpl: async (url) => {
        assert.equal(new URL(url).origin, 'https://api.openai.com');
        providerCalls++;
        return new Response(JSON.stringify({ id: 'synthetic-model' }), {
          status: 200
        });
      }
    }
  });
  server = await new Promise((resolve) => {
    const started = app.start(() => resolve(started));
  });
  base = `http://127.0.0.1:${server.address().port}`;
  config.origin = base; // Real browser Origin/CSRF checks use the dynamic local test origin.
  const adminCookie = admin.cookie.split(';')[0];
  const api = async (path, cookie = adminCookie) => {
    const response = await fetch(base + path, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200, `${path}: ${await response.clone().text()}`);
    return response.json();
  };

  const fresh = await api('/api/settings/provider');
  assert.equal(fresh.source, 'database');
  assert.equal(fresh.configured, false);
  assert.equal(fresh.enabled, false);
  assert.equal(fresh.autoClassify, false);
  proof('Real PostgreSQL fixture exposes database-only, disabled fresh defaults');

  // Retired envelopes are opaque synthetic bytes, never real deployment secrets.
  for (const [setting, provider] of [
    ['notifications.smtp.url', 'smtp'],
    ['notifications.telegram.botToken', 'telegram'],
    ['simplefin.accessUrl', 'simplefin']
  ]) {
    await pool.query('INSERT INTO encrypted_credentials(setting,provider,ciphertext) VALUES($1,$2,$3)', [
      setting,
      provider,
      {
        v: 2,
        salt: randomBytes(32).toString('base64'),
        nonce: randomBytes(12).toString('base64'),
        tag: randomBytes(16).toString('base64'),
        data: randomBytes(32).toString('base64')
      }
    ]);
  }

  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
    args: ['--no-sandbox']
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 }
  });
  async function addSession(target, cookie) {
    await target.addCookies([
      {
        name: 'dolphino_session',
        value: cookie.split('=')[1],
        url: base,
        httpOnly: true,
        sameSite: 'Strict'
      }
    ]);
    await target.route('**/*', (route) => {
      if (new URL(route.request().url()).origin !== base) {
        external.push(route.request().url());
        return route.abort();
      }

      return route.continue();
    });
  }

  await addSession(context, adminCookie);
  const page = await context.newPage();
  const assertPageStorageUnused = await installBrowserStorageGuard(page);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (request.method() === 'PUT') {
      requests.push({
        path: new URL(request.url()).pathname,
        body: request.postDataJSON()
      });
    }
  });
  const lastWrite = (path) => requests.filter((request) => request.path === path).at(-1)?.body;
  async function save(name, path) {
    const promise = page.waitForResponse(
      (response) => new URL(response.url()).pathname === path && response.request().method() === 'PUT'
    );
    await page.getByRole('button', { name, exact: true }).click();
    const response = await promise;
    assert.equal(response.status(), 200, `${path}: ${await response.text()}`);
    await expect(page.getByRole('button', { name, exact: true })).toBeEnabled();
    return response.json();
  }

  await page.goto(base);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByLabel('Redbark API key', { exact: true })).toBeEnabled();
  assert.equal(await page.getByLabel('Redbark API key', { exact: true }).inputValue(), '');
  await page.getByLabel('Redbark API key', { exact: true }).fill(key);
  await page.getByLabel('Redbark API version', { exact: true }).fill('2026-10-01.wattle');
  await page.getByLabel('Rolling backfill days', { exact: true }).fill('37');
  await page.getByText('Existing destination signing secret', { exact: true }).click();
  await page.getByLabel('Redbark signing secret', { exact: true }).fill(signingSecret);
  const redbarkSaved = await save('Save Redbark settings', '/api/settings/redbark');
  assert.equal(redbarkSaved.signingSecretAssociated, true);
  assert(!JSON.stringify(redbarkSaved).includes(key));
  assert(!JSON.stringify(redbarkSaved).includes(signingSecret));
  assert.equal((await redbarkSettings.getRuntimeConfig()).redbarkApiKey, key);
  assert.equal((await redbarkSettings.getRuntimeConfig()).redbarkBackfillDays, 37);
  assert.equal(await page.getByLabel('Redbark API key', { exact: true }).inputValue(), '');
  assert.equal(await page.getByLabel('Redbark signing secret', { exact: true }).inputValue(), '');
  assert.equal((await api('/api/settings')).redbark.configured, true);
  const ciphertext = (
    await pool.query(
      "SELECT ciphertext FROM encrypted_credentials WHERE setting='redbark.apiKey' AND provider='redbark'"
    )
  ).rows[0].ciphertext;
  assert(!JSON.stringify(ciphertext).includes(key));
  proof(
    'Redbark UI saves real encrypted PostgreSQL credentials, clears inputs and hot-reloads runtime/summary without restart'
  );

  const testResponse = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/connection/test');
  await page.getByRole('button', { name: 'Test connection', exact: true }).click();
  assert.equal((await testResponse).status(), 200);
  await expect(page.getByRole('button', { name: 'Test connection', exact: true })).toBeEnabled();
  assert.equal((await integration.status()).verified, true);
  assert.equal(redbarkCalls, 1);
  // The summary reload remounts Settings; wait for its real GET before editing.
  await expect(page.getByLabel('Redbark API key', { exact: true })).toBeEnabled();
  await page.getByLabel('Rolling backfill days', { exact: true }).fill('45');
  await save('Save Redbark settings', '/api/settings/redbark');
  assert.equal(Object.hasOwn(lastWrite('/api/settings/redbark'), 'apiKey'), false);
  assert.equal(Object.hasOwn(lastWrite('/api/settings/redbark'), 'signingSecret'), false);
  assert.deepEqual(
    (
      await pool.query(
        "SELECT ciphertext FROM encrypted_credentials WHERE setting='redbark.apiKey' AND provider='redbark'"
      )
    ).rows[0].ciphertext,
    ciphertext
  );
  assert.equal((await integration.status()).verified, true);
  assert.equal((await redbarkSettings.getRuntimeConfig()).redbarkBackfillDays, 45);
  proof(
    'Blank Redbark fields preserve identical ciphertext; backfill updates immediately without invalidating verification'
  );

  await page.getByLabel('Redbark API key', { exact: true }).fill(nextKey);
  await page.getByLabel('Redbark API version', { exact: true }).fill('2026-10-02.wattle');
  await save('Save Redbark settings', '/api/settings/redbark');
  const changed = await api('/api/settings/redbark');
  assert.equal(changed.signingSecretAssociated, false);
  assert.equal(changed.credentials.signingSecret.configured, true);
  assert.equal((await integration.status()).verified, false);
  await expect(page.getByText(/The saved signing secret is not associated with the current API key/)).toBeVisible();
  proof(
    'Redbark credential/version change hot-reloads, invalidates connection proof and retains but disassociates the prior signing secret'
  );

  await page.getByLabel('Model', { exact: true }).fill('synthetic-model');
  await page.getByLabel('OpenAI API key', { exact: true }).fill(openaiKey);
  await page.getByRole('checkbox', { name: 'Enable AI classification', exact: true }).check();
  const firstProvider = await save('Save provider settings', '/api/settings/provider');
  assert.equal(Object.hasOwn(lastWrite('/api/settings/provider'), 'region'), false);
  assert.equal(firstProvider.configured, true);
  assert.equal(firstProvider.enabled, true);
  assert.equal(firstProvider.autoClassify, false);
  assert(!JSON.stringify(firstProvider).includes(openaiKey));
  assert.equal((await settings.getProviderConfig()).llmEnabled, true);
  assert.equal((await settings.getProviderConfig()).llmAutoClassify, false);
  assert.equal(await page.getByLabel('OpenAI API key', { exact: true }).inputValue(), '');
  proof(
    'Fresh first OpenAI browser save succeeds against the real schema with no region; on-demand-only settings persist'
  );

  await page
    .getByRole('checkbox', {
      name: 'Automatically suggest categories for unresolved imports',
      exact: true
    })
    .check();
  await page
    .getByRole('checkbox', {
      name: 'Automatically apply validated category suggestions',
      exact: true
    })
    .check();
  await page.getByLabel('Requests per UTC day', { exact: true }).fill('30');
  await page.getByLabel('Maximum import batch', { exact: true }).fill('6');
  await save('Save provider settings', '/api/settings/provider');
  const automatic = await api('/api/settings/provider');
  assert.equal(automatic.autoClassify, true);
  assert.equal(automatic.autoApply, true);
  assert.equal(automatic.dailyRequestLimit, 30);
  assert.equal(automatic.batchSize, 6);
  assert.equal(Object.hasOwn(lastWrite('/api/settings/provider'), 'apiKey'), false);
  assert.equal((await settings.getProviderConfig()).llmApiKey, openaiKey);
  await page.getByRole('checkbox', { name: 'Enable AI classification', exact: true }).uncheck();
  await save('Save provider settings', '/api/settings/provider');
  const disabled = await api('/api/settings/provider');
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.autoClassify, true, 'automatic preference stays independent');
  assert.equal(disabled.autoApply, true);
  assert.equal((await settings.getProviderConfig()).llmEnabled, false);
  await assert.rejects(classification.suggest(transaction.id), /disabled/);
  await classification.tick();
  proof(
    'Independent master/automatic/apply flags and numeric limits persist; disabling master blocks actual classification while preserving preferences'
  );

  await page.getByLabel('Provider', { exact: true }).selectOption('bedrock');
  await page.getByLabel('AWS region', { exact: true }).selectOption('ap-southeast-2');
  await page.getByLabel('AWS access key ID', { exact: true }).fill('AKIASYNTHETICONLY0000');
  await page.getByLabel('AWS secret access key', { exact: true }).fill('synthetic-bedrock-secret-key');
  await save('Save provider settings', '/api/settings/provider');
  const bedrockChoices = page.getByLabel('Available classification Bedrock models', { exact: true });
  await expect(bedrockChoices).toBeEnabled();
  assert.equal(bedrockDiscoveryCalls, 2, 'Saving credentials automatically calls both read-only catalog APIs');
  assert.equal((await settings.getProviderConfig()).llmModel, '', 'No model ID needed before credentials save');
  assert.equal(
    (await settings.getProviderConfig()).llmEnabled,
    false,
    'Credentials-first save never enables inference'
  );
  await bedrockChoices.selectOption('synthetic.bedrock-model');
  assert.equal(
    (await settings.getProviderConfig()).llmModel,
    '',
    'Selecting a model does not silently save or enable it'
  );
  assert.equal((await settings.getProviderConfig()).llmProvider, 'bedrock');
  assert.equal((await settings.getProviderConfig()).llmRegion, 'ap-southeast-2');
  assert.equal((await settings.getProviderConfig()).llmEnabled, false);
  assert.equal(await page.getByLabel('AWS secret access key', { exact: true }).inputValue(), '');
  await page.getByLabel('Provider', { exact: true }).selectOption('openai');
  await page.getByLabel('Model', { exact: true }).fill('synthetic-model');
  await page.getByRole('checkbox', { name: 'Enable AI classification', exact: true }).check();
  await page
    .getByRole('checkbox', {
      name: 'Automatically suggest categories for unresolved imports',
      exact: true
    })
    .uncheck();
  await page
    .getByRole('checkbox', {
      name: 'Automatically apply validated category suggestions',
      exact: true
    })
    .uncheck();
  await save('Save provider settings', '/api/settings/provider');
  assert.equal((await settings.getProviderConfig()).llmApiKey, openaiKey);
  assert.equal((await settings.getProviderConfig()).llmEnabled, true);
  assert.equal((await api('/api/settings/provider')).credentials.accessKeyId.configured, false);
  proof(
    'Bedrock Save stores credentials without a model and automatically loads the mocked catalog; selection stays disabled and switching back preserves the original OpenAI key'
  );

  await expect(page.getByText('The saved SMTP connection cannot be decrypted.', { exact: false })).toBeVisible();
  await expect(page.getByText('The saved Telegram token cannot be decrypted.', { exact: false })).toBeVisible();
  await expect(page.getByText('Saved credentials cannot be decrypted.', { exact: false })).toBeVisible();
  await expect(page.getByLabel('SMTP connection URL', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Telegram bot token', { exact: true })).toHaveValue('');
  const unavailableNotifications = await api('/api/settings/notifications');
  assert.equal(unavailableNotifications.smtp.configured, true);
  assert.equal(unavailableNotifications.smtp.credentialsAvailable, false);
  assert.equal(unavailableNotifications.telegram.configured, true);
  assert.equal(unavailableNotifications.telegram.credentialsAvailable, false);
  const replacementSmtp = 'smtps://synthetic:replacement@smtp.example.com:465';
  const replacementTelegram = '123456:synthetic_replacement_token_for_browser';
  await page.getByLabel('SMTP connection URL', { exact: true }).fill(replacementSmtp);
  await page.getByLabel('Telegram bot token', { exact: true }).fill(replacementTelegram);
  await save('Save notification settings', '/api/settings/notifications');
  await expect(page.getByLabel('SMTP connection URL', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Telegram bot token', { exact: true })).toHaveValue('');
  await expect(page.getByText('The saved SMTP connection cannot be decrypted.', { exact: false })).toHaveCount(0);
  await expect(page.getByText('The saved Telegram token cannot be decrypted.', { exact: false })).toHaveCount(0);
  assert.equal(await settings.getSecret('notifications.smtp.url', 'smtp'), replacementSmtp);
  assert.equal(await settings.getSecret('notifications.telegram.botToken', 'telegram'), replacementTelegram);
  assert.equal((await api('/api/settings/notifications')).telegram.paired, false);
  assert.equal((await api('/api/settings/simplefin')).credentialsAvailable, false);
  proof(
    'Compiled Settings shows retired-envelope warnings with empty secret fields; explicit SMTP/Telegram replacement removes warnings without external sends, while SimpleFIN retains its recovery limitation'
  );

  await page.getByLabel('Assistant model ID', { exact: true }).fill('synthetic-assistant-model');
  await page.getByLabel('Assistant OpenAI API key', { exact: true }).fill('synthetic-assistant-key');
  await save('Save assistant settings', '/api/settings/assistant');
  assert.equal(Object.hasOwn(lastWrite('/api/settings/assistant'), 'region'), false);
  assert.equal((await assistantSettings.getPublic()).configured, true);
  assert.equal(await page.getByLabel('Assistant OpenAI API key', { exact: true }).inputValue(), '');
  proof('Fresh assistant OpenAI save succeeds independently against the real schema');

  await page.getByLabel('Assistant provider', { exact: true }).selectOption('bedrock');
  await page.getByLabel('Assistant AWS region', { exact: true }).selectOption('ap-southeast-2');
  await page.getByLabel('Assistant AWS access key ID', { exact: true }).fill('AKIASYNTHETICASSISTANT');
  await page.getByLabel('Assistant AWS secret access key', { exact: true }).fill('synthetic-assistant-bedrock-key');
  await save('Save assistant settings', '/api/settings/assistant');
  const assistantChoices = page.getByLabel('Available assistant Bedrock models', { exact: true });
  await expect(assistantChoices).toBeEnabled();
  assert.equal((await assistantSettings.getRuntimeConfig()).llmModel, '');
  assert.equal((await assistantSettings.getRuntimeConfig()).llmEnabled, false);
  assert.equal((await assistantSettings.getRuntimeConfig()).llmAccessKeyId, 'AKIASYNTHETICASSISTANT');
  await assistantChoices.selectOption('synthetic.bedrock-model');
  await save('Save assistant settings', '/api/settings/assistant');
  await expect.poll(() => bedrockDiscoveryCalls).toBe(6);
  assert.equal((await assistantSettings.getRuntimeConfig()).llmEnabled, false);
  await page.getByLabel('Assistant provider', { exact: true }).selectOption('openai');
  await page.getByLabel('Assistant model ID', { exact: true }).fill('synthetic-assistant-model');
  await save('Save assistant settings', '/api/settings/assistant');
  proof(
    'Separate assistant credentials save without a model and automatically populate the selector without enabling inference'
  );

  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByLabel('Redbark API key', { exact: true })).toBeEnabled();
  assert.equal(await page.getByLabel('Rolling backfill days', { exact: true }).inputValue(), '45');
  assert.equal(await page.getByLabel('OpenAI API key', { exact: true }).inputValue(), '');
  await expect(
    page.getByRole('checkbox', {
      name: 'Enable AI classification',
      exact: true
    })
  ).toBeChecked();
  await expect(
    page.getByRole('checkbox', {
      name: 'Automatically suggest categories for unresolved imports',
      exact: true
    })
  ).not.toBeChecked();
  await mkdir(screenshots, { recursive: true });
  await page.screenshot({
    path: `${screenshots}/dolphino-database-settings-desktop.png`,
    fullPage: true,
    animations: 'disabled'
  });
  assert.equal(await page.locator('body').evaluate((element) => element.scrollWidth <= innerWidth), true);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Open menu', exact: true }).click();
  await expect(page.locator('.sidebar')).toHaveClass(/sidebar-open/);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByLabel('Redbark API key', { exact: true })).toBeEnabled();
  await expect(page.locator('.sidebar')).not.toHaveClass(/sidebar-open/);
  await expect
    .poll(() => page.locator('.sidebar').evaluate((element) => element.getBoundingClientRect().right))
    .toBeLessThanOrEqual(0);
  await page.screenshot({
    path: `${screenshots}/dolphino-database-settings-mobile.png`,
    fullPage: true,
    animations: 'disabled'
  });
  assert.equal(
    await page.locator('body').evaluate((element) => element.scrollWidth <= innerWidth),
    true,
    'mobile settings overflow'
  );
  await page
    .locator('.integration-settings')
    .filter({
      has: page.getByRole('heading', { name: 'Redbark settings', exact: true })
    })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: `${screenshots}/dolphino-database-settings-mobile-viewport.png`,
    fullPage: false,
    animations: 'disabled'
  });
  proof(
    'Reload retains real database settings while secret inputs stay blank; mobile menu opens/closes through UI and desktop/mobile screenshots have no horizontal overflow'
  );

  await page.getByText('Existing destination signing secret', { exact: true }).click();
  await page.getByRole('checkbox', { name: 'Clear saved Redbark API key', exact: true }).check();
  await page
    .getByRole('checkbox', {
      name: 'Clear saved Redbark signing secret',
      exact: true
    })
    .check();
  await save('Save Redbark settings', '/api/settings/redbark');
  assert.equal(lastWrite('/api/settings/redbark').apiKey, null);
  assert.equal(lastWrite('/api/settings/redbark').signingSecret, null);
  assert.equal((await redbarkSettings.getRuntimeConfig()).redbarkApiKey, '');
  assert.equal((await redbarkSettings.getRuntimeConfig()).redbarkWebhookSecret, '');
  assert.equal((await pool.query("SELECT 1 FROM encrypted_credentials WHERE provider='redbark'")).rowCount, 0);
  assert.equal((await integration.status()).configured, false);
  assert.equal((await store.getTransaction(transaction.id)).description, 'Synthetic browser grocery purchase');
  proof(
    'Explicit UI clears send null, remove only Redbark encrypted slots and pause integration while preserving imported data'
  );

  const memberContext = await browser.newContext({
    viewport: { width: 1440, height: 1000 }
  });
  const memberCookie = member.cookie.split(';')[0];
  await addSession(memberContext, memberCookie);
  const memberPage = await memberContext.newPage();
  const assertMemberPageStorageUnused = await installBrowserStorageGuard(memberPage);
  memberPage.on('pageerror', (error) => errors.push(error.message));
  await memberPage.goto(base);
  await expect(memberPage.getByRole('button', { name: 'Accounts', exact: true })).toBeVisible();
  assert.equal(await memberPage.getByRole('button', { name: 'Settings', exact: true }).count(), 0);
  assert.equal(await memberPage.getByLabel('Redbark API key', { exact: true }).count(), 0);
  assert.equal(await memberPage.getByRole('button', { name: 'Save provider settings', exact: true }).count(), 0);
  for (const path of ['/api/settings', '/api/settings/redbark', '/api/settings/provider', '/api/settings/assistant']) {
    assert.equal((await fetch(base + path, { headers: { Cookie: memberCookie } })).status, 403);
    assert.equal((await fetch(base + path)).status, 401);
    if (path !== '/api/settings') {
      assert.equal(
        (
          await fetch(base + path, {
            method: 'PUT',
            headers: {
              Cookie: memberCookie,
              Origin: base,
              'Content-Type': 'application/json'
            },
            body: '{}'
          })
        ).status,
        403
      );
      assert.equal(
        (
          await fetch(base + path, {
            method: 'PUT',
            headers: { Origin: base, 'Content-Type': 'application/json' },
            body: '{}'
          })
        ).status,
        401
      );
    }
  }

  await memberPage.screenshot({
    path: `${screenshots}/dolphino-database-settings-member.png`,
    fullPage: true,
    animations: 'disabled'
  });
  proof(
    'Real member session has no Settings controls and receives 403 on every integration Settings GET/PUT; anonymous calls receive 401'
  );
  assert.equal(providerCalls, 0, 'no model/LLM network operations during configuration');
  assert.equal(redbarkCalls, 1, 'only explicitly requested connection test hit the injected Redbark transport');
  assert.deepEqual(external, [], 'browser attempted no off-local network requests');
  assert.deepEqual(errors, [], 'no browser page errors');
  await writeFile(
    `${screenshots}/database-settings-browser-evidence.json`,
    JSON.stringify(
      {
        realHttp: true,
        realPostgres: true,
        mockedApiResponses: false,
        outboundProvidersMocked: true,
        externalRequests: 0,
        screenshots: [
          'dolphino-database-settings-desktop.png',
          'dolphino-database-settings-mobile.png',
          'dolphino-database-settings-mobile-viewport.png',
          'dolphino-database-settings-member.png'
        ],
        checks: evidence
      },
      null,
      2
    ) + '\n'
  );
  await assertPageStorageUnused();
  await assertMemberPageStorageUnused();
  console.log(
    'Database integration Settings browser verification passed against real HTTP/PostgreSQL; no external provider calls.'
  );
} finally {
  await browser?.close();
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }

  await pool.end();
  await owner.query(`DROP SCHEMA ${schema} CASCADE`);
  await owner.end();
}
