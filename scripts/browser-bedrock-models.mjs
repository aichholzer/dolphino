import { readTestPostgresConfig } from '../backend/test/helpers/postgres.mjs';
import { installBrowserStorageGuard } from '../frontend/test/browser-storage-guard.mjs';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import pg from 'pg';
import { chromium, expect } from '@playwright/test';
import { ListFoundationModelsCommand, ListInferenceProfilesCommand } from '@aws-sdk/client-bedrock';
import { Store } from '../backend/src/lib/store.mjs';
import { createApp } from '../backend/src/app.mjs';
import { ensureDeploymentMode } from '../backend/src/lib/deployment-mode.mjs';
import { createHouseholdAuth } from '../backend/src/lib/household-auth.mjs';
import { ensureAccessSchema } from '../backend/src/lib/access.mjs';
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
    'Set PGHOST, PGDATABASE, PGUSER (or TEST_DATABASE_URL) for a disposable PostgreSQL database; see docs/verification.md.'
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
      return { app, auth };
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

        const item = { event: 'request', phase, method: request.method(), path, body: request.postData() };
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
      await expect(page.getByRole('button', { name: 'Save provider settings', exact: true })).toBeEnabled();
      await expect(page.getByRole('button', { name: 'Save assistant settings', exact: true })).toBeEnabled();
    }

    const label = (purpose, name) =>
      purpose === 'assistant' ? `Assistant ${name}` : name[0].toUpperCase() + name.slice(1);
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
    async function save(page, purpose) {
      phase = `${name}:save-${purpose}`;
      const path = `/api/settings/${namespace(purpose)}`;
      const responsePromise = page.waitForResponse(
        (response) => new URL(response.url()).pathname === path && response.request().method() === 'PUT'
      );
      const button = page.getByRole('button', { name: `Save ${namespace(purpose)} settings`, exact: true });
      await button.click();
      const response = await responsePromise;
      assert.equal(response.status(), 200, await response.text());
      const state = await response.json();
      assert.equal(state.provider, 'bedrock');
      assert.equal(state.encryptionAvailable, true);
      assert.equal(state.credentialsAvailable, true);
      assert.equal(state.credentials.accessKeyId.configured, true);
      assert.equal(state.credentials.secretAccessKey.configured, true);
      assert.match(state.discoveryRevision, /^[a-f0-9]{64}$/);
      await expect(button).toBeEnabled();
      return state;
    }

    async function configure(page, purpose, { model = '' } = {}) {
      await page.getByLabel(label(purpose, 'provider'), { exact: true }).selectOption('bedrock');
      await page.getByLabel(label(purpose, 'AWS region'), { exact: true }).selectOption('ap-southeast-2');
      await page
        .getByLabel(label(purpose, 'AWS access key ID'), { exact: true })
        .fill(`AKIASYNTHETIC${purpose.toUpperCase()}`);
      await page
        .getByLabel(label(purpose, 'AWS secret access key'), { exact: true })
        .fill(`synthetic-${purpose}-secret`);
      if (model) {
        await section(page, purpose)
          .getByText('Enter a model or inference profile ID manually (optional)', { exact: true })
          .click();
        await page
          .getByLabel(purpose === 'assistant' ? 'Assistant model ID' : 'Model or inference profile ID / ARN', {
            exact: true
          })
          .fill(model);
      }

      return save(page, purpose);
    }

    async function loaded(page, purpose, version = 'current') {
      await expect(choices(page, purpose)).toBeEnabled();
      await expect(choices(page, purpose)).toContainText(`synthetic.${version}-model`);
      assert.equal(await page.getByLabel(label(purpose, 'AWS access key ID'), { exact: true }).inputValue(), '');
      assert.equal(await page.getByLabel(label(purpose, 'AWS secret access key'), { exact: true }).inputValue(), '');
      const state = await read(`/api/settings/${namespace(purpose)}`);
      assert.equal(state.encryptionAvailable, true);
      assert.equal(state.credentialsAvailable, true);
      assert.equal(state.credentials.accessKeyId.configured, true);
      assert.equal(state.credentials.secretAccessKey.configured, true);
      assert.match(state.discoveryRevision, /^[a-f0-9]{64}$/);
      assert.equal(state.enabled, false, 'Discovery never enables inference');
      assert(!JSON.stringify(state).includes(`synthetic-${purpose}-secret`));
    }

    async function both(page) {
      for (const purpose of ['classification', 'assistant']) {
        await configure(page, purpose);
        await loaded(page, purpose);
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
        label,
        namespace,
        pool
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

await runScenario('save-blank-and-busy', async ({ page, both, save, loaded, choices, modelsRequests, pool }) => {
  await both(page);
  const before = (
    await pool.query('SELECT setting,provider,ciphertext FROM encrypted_credentials ORDER BY setting,provider')
  ).rows;
  for (const purpose of ['classification', 'assistant']) {
    await save(page, purpose);
    await loaded(page, purpose);
  }

  const after = (
    await pool.query('SELECT setting,provider,ciphertext FROM encrypted_credentials ORDER BY setting,provider')
  ).rows;
  assert.deepEqual(after, before, 'Blank secret fields preserve the stored ciphertext');
  const count = modelsRequests().length;
  await page.getByRole('button', { name: 'Test saved connection', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Test saved connection', exact: true })).toBeEnabled();
  await loaded(page, 'classification');
  await loaded(page, 'assistant');
  assert.equal(modelsRequests().length, count, 'A connection test cannot erase or reload an unchanged catalog');
  await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Refresh status', exact: true })).toBeEnabled();
  await loaded(page, 'classification');
  assert.equal(modelsRequests().length, count, 'An unchanged status refresh cannot reload the catalog');
  await expect(choices(page, 'assistant')).toBeEnabled();
});

for (const navigation of ['reopen', 'refresh-settings', 'reload', 'browser-restart', 'app-restart']) {
  await runScenario(
    navigation,
    async ({ page, both, enterSettings, restartBrowser, restartApp, loaded, modelsRequests, read }) => {
      await both(page);
      const previousProvider = await read('/api/settings/provider');
      const previousAssistant = await read('/api/settings/assistant');
      if (navigation === 'reopen') {
        await page.getByRole('button', { name: 'Overview', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Save provider settings', exact: true })).toHaveCount(0);
        await enterSettings(page);
      } else if (navigation === 'refresh-settings') {
        await enterSettings(page);
      } else if (navigation === 'reload') {
        await page.reload();
        await enterSettings(page);
      } else if (navigation === 'app-restart') {
        page = await restartApp();
        assert.deepEqual(await read('/api/settings/provider'), previousProvider);
        assert.deepEqual(await read('/api/settings/assistant'), previousAssistant);
      } else {
        page = await restartBrowser();
      }

      await loaded(page, 'classification');
      await loaded(page, 'assistant');
      assert.equal(modelsRequests().length, 4, 'Each reopened saved form automatically loads once');
    }
  );
}

await runScenario(
  'successful-connection-and-delayed-summary',
  async ({ page, configure, save, loaded, modelsRequests }) => {
    await configure(page, 'classification', { model: 'synthetic.current-model' });
    await loaded(page, 'classification');
    const count = modelsRequests().length;
    const response = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/settings/provider/test-connection'
    );
    await page.getByRole('button', { name: 'Test saved connection', exact: true }).click();
    assert.equal((await response).status(), 200);
    await expect(page.getByRole('button', { name: 'Test saved connection', exact: true })).toBeEnabled();
    await loaded(page, 'classification');
    assert.equal(modelsRequests().length, count);
    // Delay transport only. The actual backend still produces the whole response.
    await page.route('**/api/settings', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      await route.continue();
    });
    await save(page, 'classification');
    await loaded(page, 'classification');
    assert.equal(modelsRequests().length, count + 1);
  }
);

for (const purpose of ['classification', 'assistant']) {
  await runScenario(
    `aws-error-retry-${purpose}`,
    async ({ page, sdk, configure, section, loaded, read, namespace, modelsRequests }) => {
      sdk.fail = 'AccessDeniedException';
      await configure(page, purpose);
      await expect(section(page, purpose).getByRole('alert')).toContainText('Unable to load models');
      assert(!(await page.locator('body').innerText()).includes('synthetic-secret-must-never-be-displayed'));
      const state = await read(`/api/settings/${namespace(purpose)}`);
      assert.equal(state.credentials.accessKeyId.configured, true);
      assert.equal(state.credentials.secretAccessKey.configured, true);
      assert.equal(state.region, 'ap-southeast-2');
      assert.equal(state.enabled, false);
      sdk.fail = null;
      await section(page, purpose).getByRole('button', { name: 'Retry loading models', exact: true }).click();
      await loaded(page, purpose);
      assert.equal(modelsRequests().length, 2, 'Failure does not create an automatic retry loop');
    }
  );
  await runScenario(
    `slow-abort-${purpose}`,
    async ({ page, sdk, configure, save, loaded, choices, label, modelsRequests, trace }) => {
      const pending = gate();
      sdk.gate = pending;
      sdk.version = 'obsolete';
      await configure(page, purpose);
      await expect.poll(() => sdk.calls).toBeGreaterThan(0);
      await expect(choices(page, purpose)).toContainText('Loading models');
      await page.getByLabel(label(purpose, 'AWS region'), { exact: true }).selectOption('ap-south-1');
      await expect(choices(page, purpose)).toBeDisabled();
      sdk.gate = null;
      sdk.version = 'current';
      await save(page, purpose);
      await loaded(page, purpose);
      pending.resolve();
      await page.waitForTimeout(100);
      await expect(choices(page, purpose)).not.toContainText('obsolete');
      assert.equal(modelsRequests().length, 2, 'Dirty region cancels discovery until explicitly saved');
      assert(
        trace.some((item) => item.event === 'failed' && item.path.endsWith('/models')),
        'Superseded actual HTTP request was aborted'
      );
    }
  );
}

await runScenario('slow-busy-preserves-request', async ({ page, sdk, configure, loaded, modelsRequests }) => {
  const pending = gate();
  sdk.gate = pending;
  await configure(page, 'classification', { model: 'synthetic.current-model' });
  await expect.poll(() => sdk.calls).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Test saved connection', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Test saved connection', exact: true })).toBeEnabled();
  sdk.gate = null;
  pending.resolve();
  await loaded(page, 'classification');
  assert.equal(modelsRequests().length, 1, 'Unchanged connection/status refresh preserves in-flight discovery');
});
console.log('Bedrock saved-settings lifecycle passed against real HTTP/PostgreSQL and compiled frontend.');
