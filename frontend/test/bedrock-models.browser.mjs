import { readTestPostgresConfig } from '../../backend/test/helpers/postgres.mjs';
import { installBrowserStorageGuard } from './browser-storage-guard.mjs';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import pg from 'pg';
import { chromium, expect } from '@playwright/test';
import { ListFoundationModelsCommand, ListInferenceProfilesCommand } from '@aws-sdk/client-bedrock';
import { Store } from '../../backend/src/lib/store.mjs';
import { createApp } from '../../backend/src/app.mjs';
import { ensureDeploymentMode } from '../../backend/src/lib/deployment-mode.mjs';
import { createHouseholdAuth } from '../../backend/src/lib/household-auth.mjs';
import { ensureAccessSchema } from '../../backend/src/lib/access.mjs';
import { createSettingsStore } from '../../backend/src/lib/settings.mjs';
import { createRedbarkSettings } from '../../backend/src/lib/redbark-settings.mjs';
import { createRedbarkIntegration } from '../../backend/src/lib/worker.mjs';
import { createRegistration } from '../../backend/src/lib/registration.mjs';
import { createClassificationIntegration } from '../../backend/src/lib/classification.mjs';
import { createAiSettings } from '../../backend/src/lib/ai-settings.mjs';
import { createNotificationIntegration } from '../../backend/src/lib/notifications.mjs';
import { createTelegramPairing } from '../../backend/src/lib/telegram.mjs';
import { createImportHealth } from '../../backend/src/lib/import-health.mjs';
import { createUserManagement } from '../../backend/src/lib/users.mjs';

// Real compiled frontend, real authenticated HTTP application and isolated PostgreSQL.
// Only the outbound AWS SDK clients are injected. API responses are never fulfilled
// or rewritten. Each case creates a fresh app with its normal discovery rate limit.
const output = process.env.DOLPHINO_SCREENSHOT_DIR || 'artifacts/bedrock-lifecycle';
const evidence = [];
const build = /src="\/assets\/([^"]+)"/.exec(await readFile('frontend/dist/index.html', 'utf8'))?.[1];
await mkdir(output, { recursive: true });
async function runScenario(name, test) {
  if (process.env.DOLPHINO_BEDROCK_SCENARIO && name !== process.env.DOLPHINO_BEDROCK_SCENARIO) {
    return;
  }

  const database = readTestPostgresConfig();
  assert(
    database,
    'Set PGHOST, PGDATABASE, PGUSER (or TEST_DATABASE_URL) for a disposable PostgreSQL database; see docs/testing.md.'
  );
  const owner = new pg.Pool(database);
  const schema = `browser_settings_${randomUUID().replaceAll('-', '')}`;
  await owner.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({
    ...database,
    options: `-c search_path=${schema}`
  });
  const errors = [],
    external = [],
    requests = [],
    trace = [];
  const sdk = { calls: 0, fail: null, gate: null, version: 'current' };
  const guards = [];
  const gates = new Set();
  let phase = name;
  let server, browser, base;

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

  try {
    async function buildApp() {
      await ensureDeploymentMode(pool, 'live');
      const store = new Store(pool, { mode: 'live', timezone: config.timezone });
      await store.migrate();
      const vault = createSettingsStore({ pool, appSecret: config.appSecret });
      await vault.init();
      if (name.startsWith('migration-') && !(await vault.getValue('llm'))) {
        await vault.setValue('llm', {
          provider: 'bedrock',
          region: 'ap-southeast-2',
          model: 'legacy-classifier',
          enabled: true,
          autoClassify: true,
          autoApply: false,
          dailyRequestLimit: 31,
          batchSize: 6
        });
        await vault.setValue('assistant.llm', {
          provider: 'bedrock',
          region: 'ap-southeast-2',
          model: 'legacy-assistant',
          enabled: true,
          dataSharingAcknowledged: true,
          dailyRequestsPerUser: 13,
          maxToolCalls: 4,
          maxRounds: 3,
          maxOutputTokens: 1024
        });
        for (const source of ['llm', 'assistant.llm']) {
          await vault.setSecret(
            `${source}.accessKeyId`,
            'bedrock',
            `AKIASYNTHETIC${source === 'llm' ? 'CLASSIFIER' : 'ASSISTANT'}`
          );
          await vault.setSecret(`${source}.secretAccessKey`, 'bedrock', `synthetic-old-${source}-secret`);
        }

        if (name === 'migration-unavailable-profile') {
          await pool.query("UPDATE encrypted_credentials SET ciphertext=$1 WHERE setting='llm.secretAccessKey'", [
            { v: 2, data: 'synthetic-retired-envelope' }
          ]);
        }
      }

      const aiSettings = createAiSettings({ pool, settings: vault, appSecret: config.appSecret });
      await aiSettings.init();
      const settings = { ...vault, ...aiSettings.classification };
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
      const assistantSettings = aiSettings.assistant;
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
        aiSettings,
        notifications,
        telegram,
        importHealth,
        providerDependencies: {
          stsClient: {
            send: async () => ({ Account: '000000000000', Arn: 'arn:aws:iam::000000000000:user/synthetic' })
          },
          bedrockControlClient: {
            send: async (command) => {
              sdk.calls++;
              const { gate, fail, version } = sdk;
              if (gate) {
                gates.add(gate);
                await gate.promise;
              }

              if (fail) {
                throw Object.assign(new Error('synthetic-secret-must-never-be-displayed'), { name: fail });
              }

              if (command instanceof ListFoundationModelsCommand) {
                return {
                  modelSummaries: [
                    {
                      modelId: `synthetic.${version}-model`,
                      modelName: `Synthetic ${version} Bedrock model`,
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
          fetchImpl: forbiddenOutbound
        }
      });
      return { app, auth, settings, assistantSettings };
    }

    let fixture = await buildApp();
    const admin = await fixture.auth.bootstrap(
      { headers: {}, socket: { remoteAddress: 'synthetic-browser-fixture' } },
      {
        email: 'synthetic-admin@example.com',
        name: 'Synthetic admin',
        password: 'synthetic browser password',
        bootstrapToken: config.bootstrapToken
      }
    );
    async function startApp() {
      server = await new Promise((resolve) => {
        const started = fixture.app.start(() => resolve(started));
      });
      base = `http://127.0.0.1:${server.address().port}`;
      config.origin = base; // Real browser Origin/CSRF checks use the dynamic local test origin.
    }

    await startApp();
    const adminCookie = admin.cookie.split(';')[0];
    const read = async (path, cookie = adminCookie) => {
      const response = await fetch(base + path, { headers: { Cookie: cookie } });
      assert.equal(response.status, 200, `${path}: ${await response.clone().text()}`);
      return response.json();
    };

    async function openPage() {
      if (!browser) {
        browser = await chromium.launch({
          executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
          args: ['--no-sandbox']
        });
      }

      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      await context.addCookies([
        { name: 'dolphino_session', value: adminCookie.split('=')[1], url: base, httpOnly: true, sameSite: 'Strict' }
      ]);
      await context.route('**/*', (route) => {
        if (new URL(route.request().url()).origin !== base) {
          external.push(route.request().url());
          return route.abort();
        }

        return route.continue();
      });
      const page = await context.newPage();
      guards.push({ page, check: await installBrowserStorageGuard(page) });
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('request', (request) => {
        const path = new URL(request.url()).pathname;
        if (!path.startsWith('/api/')) {
          return;
        }

        const body = request.postDataJSON();
        const item = { event: 'request', phase, method: request.method(), path, fields: body ? Object.keys(body) : [] };
        if (path === '/api/settings/ai/models') {
          assert.deepEqual(Object.keys(body), ['revision']);
        }

        if (request.method() === 'PUT' && ['/api/settings/provider', '/api/settings/assistant'].includes(path)) {
          for (const forbidden of ['provider', 'region', 'apiKey', 'accessKeyId', 'secretAccessKey']) {
            assert(!Object.hasOwn(body, forbidden), `Feature write cannot include ${forbidden}`);
          }

          assert.match(body.aiRevision, /^[a-f0-9]{64}$/);
        }

        requests.push(item);
        trace.push(item);
      });
      page.on('requestfailed', (request) =>
        trace.push({
          event: 'failed',
          phase,
          method: request.method(),
          path: new URL(request.url()).pathname,
          error: request.failure()
        })
      );
      page.on('response', (response) => {
        const path = new URL(response.url()).pathname;
        if (path.startsWith('/api/')) {
          trace.push({
            event: 'response',
            phase,
            method: response.request().method(),
            path,
            status: response.status()
          });
        }
      });
      await page.goto(base);
      await enterSettings(page);
      return page;
    }

    async function enterSettings(page) {
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await page.getByRole('link', { name: /^AI features/ }).click();
      await expect(page.getByRole('button', { name: 'Save AI connection', exact: true })).toBeEnabled();
      await expect(page.getByRole('button', { name: 'Save classification settings', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Save assistant settings', exact: true })).toBeVisible();
    }

    const namespace = (purpose) => (purpose === 'assistant' ? 'assistant' : 'provider');
    const choices = (page, purpose) => page.getByLabel(`Available ${purpose} Bedrock models`, { exact: true });
    const modelsRequests = () => requests.filter((item) => item.path.endsWith('/models'));
    const section = (page, purpose) =>
      page.locator('.integration-settings').filter({
        has: page.getByRole('heading', {
          name: purpose === 'assistant' ? 'Read-only financial assistant' : 'Optional AI classification',
          exact: true
        })
      });
    async function savePath(page, path, label) {
      phase = `${name}:save-${path}`;
      const responsePromise = page.waitForResponse(
        (response) => new URL(response.url()).pathname === path && response.request().method() === 'PUT'
      );
      const button = page.getByRole('button', { name: label, exact: true });
      await button.click();
      const response = await responsePromise;
      assert.equal(response.status(), 200, await response.text());
      const state = await response.json();
      await expect(button).toBeEnabled();
      return state;
    }

    const save = (page, purpose) => savePath(page, `/api/settings/${namespace(purpose)}`, `Save ${purpose} settings`);
    const saveShared = (page) => savePath(page, '/api/settings/ai', 'Save AI connection');
    async function configure(page) {
      await page.getByLabel('AI provider', { exact: true }).selectOption('bedrock');
      await page.getByLabel('AWS region', { exact: true }).selectOption('ap-southeast-2');
      await page.getByLabel('AWS access key ID', { exact: true }).fill('AKIASYNTHETICSHARED');
      await page.getByLabel('AWS secret access key', { exact: true }).fill('synthetic-shared-secret');
      return saveShared(page);
    }

    async function loaded(page, purpose, version = 'current') {
      await expect(choices(page, purpose)).toBeEnabled();
      await expect(choices(page, purpose)).toContainText(`synthetic.${version}-model`);
      assert.equal(await page.getByLabel('AWS access key ID', { exact: true }).inputValue(), '');
      assert.equal(await page.getByLabel('AWS secret access key', { exact: true }).inputValue(), '');
      const state = await read('/api/settings/ai');
      assert.equal(state.encryptionAvailable, true);
      assert.equal(state.credentialsAvailable, true);
      assert.equal(state.credentials.accessKeyId.configured, true);
      assert.equal(state.credentials.secretAccessKey.configured, true);
      assert.match(state.discoveryRevision, /^[a-f0-9]{64}$/);
      assert(!JSON.stringify(state).includes('synthetic-shared-secret'));
    }

    async function both(page) {
      await configure(page);
      await loaded(page, 'classification');
      await loaded(page, 'assistant');
      assert.equal(modelsRequests().length, 1, 'Both pickers share one credential-scoped catalog request');
      for (const purpose of ['classification', 'assistant']) {
        const state = await read(`/api/settings/${namespace(purpose)}`);
        assert.equal(state.enabled, false, 'Credential discovery never enables either feature');
        assert.equal(state.model, '', 'Credentials save does not choose a model');
      }
    }

    async function restartBrowser() {
      for (const guard of guards) {
        if (!guard.page.isClosed()) {
          await guard.check();
        }
      }

      await browser.close();
      browser = null;
      return openPage();
    }

    async function restartApp() {
      for (const guard of guards) {
        if (!guard.page.isClosed()) {
          await guard.check();
        }
      }

      await browser.close();
      browser = null;
      await new Promise((resolve) => server.close(resolve));
      fixture = await buildApp();
      await startApp();
      return openPage();
    }

    const page = await openPage();
    try {
      await test({
        page,
        sdk,
        read,
        save,
        saveShared,
        configure,
        loaded,
        both,
        choices,
        section,
        modelsRequests,
        enterSettings,
        restartBrowser,
        restartApp,
        requests,
        trace,
        namespace,
        pool,
        runtime: async () => [
          await fixture.settings.getProviderConfig(),
          await fixture.assistantSettings.getRuntimeConfig()
        ]
      });
      for (const guard of guards) {
        if (!guard.page.isClosed()) {
          await guard.check();
        }
      }

      assert.deepEqual(external, [], 'No off-local browser requests');
      assert.deepEqual(errors, [], 'No browser errors');
      assert(modelsRequests().length <= 5, 'Each fixture respects the unmodified five-discovery rate limit');
      assert(!trace.some((item) => item.status === 429), 'No accidental local rate limit');
      evidence.push({ name, result: 'passed', modelsRequests: modelsRequests().length, sdkCalls: sdk.calls, trace });
      for (const guard of guards) {
        if (!guard.page.isClosed()) {
          await guard.page.screenshot({ path: `${output}/${name}.png`, fullPage: true, animations: 'disabled' });
          break;
        }
      }

      console.log(`PASS ${name}`);
    } catch (error) {
      evidence.push({ name, result: 'failed', error: error.message, trace });
      for (const guard of guards) {
        if (!guard.page.isClosed()) {
          await guard.page.screenshot({
            path: `${output}/${name}-failure.png`,
            fullPage: true,
            animations: 'disabled'
          });
          break;
        }
      }

      throw error;
    } finally {
      for (const pending of gates) {
        pending.resolve();
      }

      sdk.gate?.resolve();
      await writeFile(
        `${output}/evidence.json`,
        JSON.stringify(
          {
            build,
            realHttp: true,
            realPostgres: true,
            mockedApiResponses: false,
            outboundSdkMocked: true,
            cases: evidence
          },
          null,
          2
        ) + '\n'
      );
    }
  } finally {
    await browser?.close();
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }

    await pool.end();
    await owner.query(`DROP SCHEMA ${schema} CASCADE`);
    await owner.end();
  }
}

function gate() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

await runScenario(
  'save-blank-and-busy',
  async ({ page, both, save, saveShared, loaded, choices, modelsRequests, pool, read }) => {
    await both(page);
    const before = (
      await pool.query('SELECT setting,provider,ciphertext FROM encrypted_credentials ORDER BY setting,provider')
    ).rows;
    const refreshed = await saveShared(page);
    for (const purpose of ['classification', 'assistant']) {
      await choices(page, purpose).selectOption('synthetic.current-model');
      await save(page, purpose);
      await loaded(page, purpose);
    }

    const after = (
      await pool.query('SELECT setting,provider,ciphertext FROM encrypted_credentials ORDER BY setting,provider')
    ).rows;
    assert.deepEqual(after, before, 'Blank shared secret fields and feature saves preserve stored ciphertext');
    assert.equal(
      (await read('/api/settings/ai')).discoveryRevision,
      refreshed.discoveryRevision,
      'Feature saves do not change credential revision'
    );
    assert.equal(
      modelsRequests().length,
      2,
      'Explicit shared save reloads once; feature saves do not reload the shared catalog'
    );
    const response = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/settings/ai/test-connection'
    );
    await page.getByRole('button', { name: 'Test saved connection', exact: true }).click();
    assert.equal((await response).status(), 200);
    await expect(page.getByRole('button', { name: 'Test saved connection', exact: true })).toBeEnabled();
    await loaded(page, 'classification');
    await loaded(page, 'assistant');
    assert.equal(modelsRequests().length, 2, 'Credential-only connection test preserves catalog');
  }
);

for (const navigation of ['reopen', 'refresh-settings', 'reload', 'browser-restart', 'app-restart']) {
  await runScenario(
    navigation,
    async ({ page, both, enterSettings, restartBrowser, restartApp, loaded, modelsRequests, read }) => {
      await both(page);
      const previous = await read('/api/settings/ai');
      if (navigation === 'reopen') {
        await page.getByRole('button', { name: 'Overview', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Save classification settings', exact: true })).toHaveCount(0);
        await enterSettings(page);
      } else if (navigation === 'refresh-settings') {
        await enterSettings(page);
      } else if (navigation === 'reload') {
        await page.reload();
        await expect(page).toHaveURL(/#settings\/ai$/);
      } else if (navigation === 'app-restart') {
        page = await restartApp();
      } else {
        page = await restartBrowser();
      }

      await loaded(page, 'classification');
      await loaded(page, 'assistant');
      assert.deepEqual(await read('/api/settings/ai'), previous);
      assert.equal(modelsRequests().length, 2, 'Each reopened AI section loads one shared catalog');
    }
  );
}

await runScenario('aws-error-retry-shared', async ({ page, sdk, configure, section, loaded, read, modelsRequests }) => {
  sdk.fail = 'AccessDeniedException';
  await configure(page);
  for (const purpose of ['classification', 'assistant']) {
    await expect(section(page, purpose).getByRole('alert')).toContainText('Unable to load models');
  }

  assert(!(await page.locator('body').innerText()).includes('synthetic-secret-must-never-be-displayed'));
  const state = await read('/api/settings/ai');
  assert.equal(state.credentials.accessKeyId.configured, true);
  assert.equal(state.credentials.secretAccessKey.configured, true);
  assert.equal(state.region, 'ap-southeast-2');
  sdk.fail = null;
  await section(page, 'classification').getByRole('button', { name: 'Retry loading models', exact: true }).click();
  await loaded(page, 'classification');
  await loaded(page, 'assistant');
  assert.equal(modelsRequests().length, 2, 'Failure stays visible until one explicit shared Retry');
});

await runScenario(
  'slow-region-abort',
  async ({ page, sdk, configure, saveShared, loaded, choices, modelsRequests, trace }) => {
    const pending = gate();
    sdk.gate = pending;
    sdk.version = 'obsolete';
    await configure(page);
    await expect.poll(() => sdk.calls).toBeGreaterThan(0);
    await expect(choices(page, 'classification')).toContainText('Loading models');
    await page.getByLabel('AWS region', { exact: true }).selectOption('ap-south-1');
    await expect(choices(page, 'classification')).toBeDisabled();
    await expect(choices(page, 'assistant')).toBeDisabled();
    sdk.gate = null;
    sdk.version = 'current';
    await saveShared(page);
    await loaded(page, 'classification');
    await loaded(page, 'assistant');
    pending.resolve();
    await page.waitForTimeout(100);
    await expect(choices(page, 'classification')).not.toContainText('obsolete');
    await expect(choices(page, 'assistant')).not.toContainText('obsolete');
    assert.equal(modelsRequests().length, 2, 'Dirty region cancels shared discovery until saved');
    assert(
      trace.some((item) => item.event === 'failed' && item.path.endsWith('/models')),
      'Superseded actual HTTP request aborted'
    );
  }
);

await runScenario('slow-busy-preserves-request', async ({ page, sdk, configure, loaded, modelsRequests }) => {
  const pending = gate();
  sdk.gate = pending;
  await configure(page);
  await expect.poll(() => sdk.calls).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Test saved connection', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Test saved connection', exact: true })).toBeEnabled();
  sdk.gate = null;
  pending.resolve();
  await loaded(page, 'classification');
  await loaded(page, 'assistant');
  assert.equal(modelsRequests().length, 1, 'Unchanged connection test preserves the in-flight catalog');
});

await runScenario(
  'slow-unmount-and-return',
  async ({ page, sdk, configure, enterSettings, loaded, choices, modelsRequests }) => {
    const pending = gate();
    sdk.gate = pending;
    sdk.version = 'obsolete';
    await configure(page);
    await expect.poll(() => sdk.calls).toBeGreaterThan(0);
    await page.getByRole('link', { name: /^Data/ }).click();
    await expect(choices(page, 'classification')).toHaveCount(0);
    sdk.gate = null;
    sdk.version = 'current';
    await enterSettings(page);
    await loaded(page, 'classification');
    await loaded(page, 'assistant');
    pending.resolve();
    await page.waitForTimeout(100);
    await expect(choices(page, 'classification')).not.toContainText('obsolete');
    assert.equal(modelsRequests().length, 2, 'Unmounted request cannot populate the reopened section');
  }
);
for (const migration of ['conflict', 'unavailable-profile']) {
  await runScenario(
    `migration-${migration}`,
    async ({ page, read, saveShared, loaded, pool, modelsRequests, runtime }) => {
      const before = await read('/api/settings/ai');
      assert.equal(before.migration.status, migration === 'conflict' ? 'conflict' : 'credentials-unavailable');
      assert.equal(before.migration.sources.length, 2);
      for (const config of await runtime()) {
        assert.equal(
          config.llmEnabled,
          false,
          'Migration blocks actual inference regardless of retained enable preferences'
        );
      }

      await expect(page.getByRole('button', { name: 'Save classification settings', exact: true })).toBeDisabled();
      const resolution = page.getByLabel('Resolve existing AI credentials', { exact: true });
      await expect(resolution).toBeVisible();
      if (migration !== 'conflict') {
        assert.equal(
          await resolution.locator('option[value="classification"]').evaluate((option) => option.disabled),
          true
        );
      }

      await resolution.selectOption('assistant');
      const saved = await saveShared(page);
      assert.equal(saved.migration.status, 'ready');
      await loaded(page, 'classification');
      await loaded(page, 'assistant');
      const classification = await read('/api/settings/provider');
      const assistant = await read('/api/settings/assistant');
      assert.equal(classification.model, 'legacy-classifier');
      assert.equal(Object.hasOwn(classification, 'dailyRequestLimit'), false);
      assert.equal(assistant.model, 'legacy-assistant');
      assert.equal(Object.hasOwn(assistant, 'dailyRequestsPerUser'), false);
      assert.equal(classification.enabled, false);
      assert.equal(assistant.enabled, false);
      assert.equal(modelsRequests().length, 1);
      assert.equal(
        (
          await pool.query(
            "SELECT 1 FROM encrypted_credentials WHERE setting LIKE 'llm.%' OR setting LIKE 'assistant.llm.%'"
          )
        ).rowCount,
        0,
        'Explicit profile resolution retires both old credential namespaces'
      );
      const text = await page.locator('body').innerText();
      assert(
        !text.includes('synthetic-old-') && !text.includes('AKIASYNTHETIC'),
        'Migration never displays secret values'
      );
    }
  );
}

console.log('Shared AI saved-settings lifecycle passed against real HTTP/PostgreSQL and compiled frontend.');
