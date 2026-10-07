import { installBrowserStorageGuard } from './browser-storage-guard.mjs';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createCompiledServer } from './compiled-server.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { expect } from '@playwright/test';
import { chromium } from './browser.mjs';

// Focused UI race and error fixtures. The companion bedrock-models.browser.mjs
// and integration-settings-db.browser.mjs run the same production UI over real
// authenticated HTTP/PostgreSQL, with only outbound provider transports injected.
const server = await createCompiledServer({ root: fileURLToPath(new URL('..', import.meta.url)) });
await server.listen();
const base = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
  args: ['--no-sandbox']
});
const evidence = [];
const output = process.env.DOLPHINO_SCREENSHOT_DIR || 'artifacts/settings-races';
await mkdir(output, { recursive: true });
let revision = 0;
const nextRevision = () => (++revision).toString(16).padStart(64, '0');
const credential = (configured = false) => ({ configured, masked: configured ? '••••••••' : '' });
const models = [
  {
    id: 'synthetic.text-v1',
    name: 'Text model',
    provider: 'Synthetic provider',
    kind: 'foundation',
    lifecycle: 'ACTIVE',
    regions: ['ap-southeast-2'],
    compatibility: 'unverified'
  },
  {
    id: 'synthetic.legacy-v1',
    name: 'Legacy text model',
    provider: 'Synthetic provider',
    kind: 'foundation',
    lifecycle: 'LEGACY',
    regions: ['ap-southeast-2'],
    compatibility: 'unverified'
  },
  {
    id: 'apac.synthetic.text-v1',
    name: 'Regional text profile',
    provider: 'Synthetic provider',
    kind: 'system-profile',
    lifecycle: 'ACTIVE',
    regions: ['ap-southeast-2', 'us-east-1'],
    compatibility: 'unverified'
  },
  {
    id: 'synthetic-application-profile',
    name: 'Household application profile',
    provider: '',
    kind: 'application-profile',
    lifecycle: 'UNKNOWN',
    regions: [],
    compatibility: 'unverified'
  }
];

async function scenario(name, test) {
  if (process.env.DOLPHINO_SETTINGS_SCENARIO && process.env.DOLPHINO_SETTINGS_SCENARIO !== name) {
    return;
  }

  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const checkStorage = await installBrowserStorageGuard(page);
  const calls = [],
    errors = [],
    responses = [],
    pending = { discovery: [], save: [], connection: [] };
  const mode = {
    discovery: 'success',
    save: 'success',
    connection: 'success',
    demo: false,
    role: 'admin',
    authenticated: true
  };
  const redbark = {
    version: '2026-10-01.wattle',
    backfillDays: 90,
    source: 'database',
    configured: false,
    encryptionAvailable: true,
    credentialsAvailable: true,
    signingSecretAssociated: false,
    credentials: { apiKey: credential(), signingSecret: credential() }
  };
  const shared = {
    provider: 'openai',
    region: '',
    discoveryRevision: nextRevision(),
    source: 'database',
    encryptionAvailable: true,
    credentialsAvailable: true,
    configured: false,
    migration: { status: 'ready', message: null, sources: [] },
    credentials: { apiKey: credential(), accessKeyId: credential(), secretAccessKey: credential() },
    regionCatalog: {
      regions: [
        { id: 'ap-southeast-2', label: 'Sydney' },
        { id: 'us-east-1', label: 'Northern Virginia' }
      ]
    }
  };
  const features = {
    provider: {
      model: '',
      enabled: false,
      autoClassify: false,
      autoApply: false,
      includeHistory: false,
      classifyFrom: ''
    },
    assistant: {
      model: '',
      enabled: false,
      dataSharingAcknowledged: false,
      disclosure:
        'When enabled, questions and authorized financial data may be sent to the selected AI provider. The assistant is read-only.'
    }
  };
  page.on('pageerror', (error) => errors.push(error.message));
  const release = (kind) => {
    for (const resolve of pending[kind].splice(0)) {
      resolve();
    }
  };

  const wait = (kind) => new Promise((resolve) => pending[kind].push(resolve));
  const featureState = (key) => ({
    ...shared,
    ...features[key],
    configured: shared.configured && !!features[key].model
  });
  await page.route('**/api/**', async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname,
      body = request.postDataJSON();
    calls.push({ path, method: request.method(), body });
    let data = {},
      status = 200;
    if (path === '/api/session') {
      data = {
        authenticated: mode.authenticated,
        demo: mode.demo,
        currency: 'AUD',
        timeZone: 'Australia/Brisbane',
        user: {
          id: `${mode.role}-synthetic`,
          name: 'Synthetic user',
          email: `${mode.role}@example.com`,
          role: mode.role
        },
        permissions: { financialAccess: true, accounts: [{ accountId: 'one', access: 'view' }], budgets: [] }
      };
    } else if (path === '/api/logout') {
      mode.authenticated = false;
      data = { ok: true };
    } else if (path === '/api/login') {
      mode.authenticated = true;
      data = { ok: true };
    } else if (path === '/api/dashboard') {
      data = { incomeMinor: '0', expensesMinor: '0', netMinor: '0' };
    } else if (path === '/api/settings') {
      data = { redbark: { configured: redbark.configured, version: redbark.version } };
    } else if (path === '/api/settings/redbark') {
      if (request.method() === 'PUT') {
        if (mode.save === 'failure') {
          return route.fulfill({ status: 400, json: { error: 'Synthetic settings save failed' } });
        }

        for (const key of ['version', 'backfillDays']) {
          if (Object.hasOwn(body, key)) {
            redbark[key] = body[key];
          }
        }

        for (const key of ['apiKey', 'signingSecret']) {
          if (Object.hasOwn(body, key) && body[key] !== '') {
            redbark.credentials[key] = credential(body[key] !== null);
          }
        }

        redbark.configured = redbark.credentials.apiKey.configured;
        redbark.signingSecretAssociated = redbark.credentials.signingSecret.configured;
      }

      data = redbark;
    } else if (path === '/api/settings/ai/models') {
      assert.deepEqual(Object.keys(body), ['revision']);
      assert.equal(body.revision, shared.discoveryRevision);
      data = {
        revision: shared.discoveryRevision,
        region: shared.region,
        models: mode.discovery === 'empty' ? [] : models,
        warnings: ['Model compatibility has not been verified.'],
        truncated: mode.discovery === 'partial'
      };
      if (mode.discovery === 'permission') {
        status = 403;
        data = { error: 'Bedrock discovery permission denied.' };
      }

      if (mode.discovery === 'stale') {
        status = 409;
        data = { error: 'Saved configuration changed. Refresh settings.' };
      }

      if (mode.discovery === 'mismatch') {
        data.revision = 'f'.repeat(64);
      }

      data = structuredClone(data);
      if (mode.discovery === 'deferred') {
        await wait('discovery');
      }
    } else if (path === '/api/settings/ai/test-connection') {
      assert(!body || !Object.hasOwn(body, 'model'), 'Shared connection test is credential-only');
      data = { message: 'Synthetic shared connection tested.' };
      if (mode.connection === 'deferred') {
        await wait('connection');
      }
    } else if (path === '/api/settings/ai') {
      if (request.method() === 'PUT') {
        assert.equal(body.revision, shared.discoveryRevision);
        assert(!Object.hasOwn(body, 'model'));
        if (mode.save === 'failure' || mode.save === 'deferred-failure') {
          if (mode.save === 'deferred-failure') {
            await wait('save');
          }

          return route.fulfill({ status: 400, json: { error: 'Synthetic settings save failed' } });
        }

        const providerChanged = shared.provider !== body.provider;
        const changed =
          providerChanged ||
          (body.provider === 'bedrock' && shared.region !== body.region) ||
          ['apiKey', 'accessKeyId', 'secretAccessKey'].some((key) => Object.hasOwn(body, key) && body[key] !== '');
        shared.provider = body.provider;
        shared.region = body.provider === 'bedrock' ? body.region : '';
        for (const key of ['apiKey', 'accessKeyId', 'secretAccessKey']) {
          if (Object.hasOwn(body, key) && body[key] !== '') {
            shared.credentials[key] = credential(body[key] !== null);
          }
        }

        shared.configured =
          shared.provider === 'bedrock'
            ? shared.credentials.accessKeyId.configured && shared.credentials.secretAccessKey.configured
            : shared.credentials.apiKey.configured;
        shared.discoveryRevision = nextRevision();
        if (changed) {
          for (const feature of Object.values(features)) {
            feature.enabled = false;
            if (providerChanged) {
              feature.model = '';
            }
          }
        }
      }

      data = structuredClone(shared);
      if (request.method() === 'PUT' && mode.save === 'deferred') {
        await wait('save');
      }
    } else if (['/api/settings/provider', '/api/settings/assistant'].includes(path)) {
      const key = path.split('/').at(-1);
      if (request.method() === 'PUT') {
        for (const field of ['provider', 'region', 'apiKey', 'accessKeyId', 'secretAccessKey']) {
          assert(!Object.hasOwn(body, field));
        }

        if (body.aiRevision !== shared.discoveryRevision) {
          return route.fulfill({
            status: 409,
            json: { error: 'Shared AI connection changed. Reload saved settings before saving.' }
          });
        }

        if (mode.save === 'failure' || mode.save === 'deferred-failure') {
          if (mode.save === 'deferred-failure') {
            await wait('save');
          }

          return route.fulfill({ status: 400, json: { error: 'Synthetic settings save failed' } });
        }

        const { aiRevision: _revision, ...values } = body;
        Object.assign(features[key], values);
      }

      data = structuredClone(featureState(key));
      if (request.method() === 'PUT' && mode.save === 'deferred') {
        await wait('save');
      }
    } else if (path === '/api/settings/webhook') {
      data = {
        state: 'registered',
        destinationId: 'synthetic-destination',
        publicBaseUrl: 'https://dolphino.example.com'
      };
    } else if (['/api/settings/simplefin', '/api/settings/pocketsmith'].includes(path)) {
      data = {
        configured: false,
        backfillDays: 30,
        enabled: false,
        encryptionAvailable: true,
        credentialsAvailable: true,
        accounts: [],
        queuedWindows: 0,
        pausedWindows: 0
      };
    } else if (path === '/api/settings/notifications') {
      data = { smtp: { enabled: false, from: '', recipients: [] }, telegram: { enabled: false } };
    } else if (path === '/api/notifications/deliveries') {
      data = [];
    } else if (path === '/api/users') {
      data = { users: [], invitations: [] };
    } else if (path === '/api/users/grant-options') {
      data = { accounts: [], budgets: [] };
    } else if (path === '/api/import-health') {
      data = { accounts: [], jobs: [] };
    } else if (path === '/api/categories' || path === '/api/settings/categories') {
      data = { catalog: [] };
    } else if (path === '/api/accounts' || path === '/api/settings/deleted-accounts') {
      data = { accounts: [] };
    }

    responses.push(JSON.stringify(data));
    await route.fulfill({ status, json: data });
  });
  const nav = (name) =>
    ['Bank feeds', 'Categories', 'Members', 'Notifications', 'Data', 'AI features'].includes(name)
      ? page.getByRole('link', { name: new RegExp(`^${name}`) })
      : page.getByRole('button', { name, exact: true });
  const section = (purpose) =>
    page.locator('.integration-settings').filter({
      has: page.getByRole('heading', {
        name: purpose === 'assistant' ? 'Read-only financial assistant' : 'Optional AI classification',
        exact: true
      })
    });
  const choices = (purpose) => page.getByLabel(`Available ${purpose} Bedrock models`, { exact: true });
  const count = () => calls.filter((call) => call.path === '/api/settings/ai/models').length;
  const lastWrite = (path) => calls.filter((call) => call.path === path && call.method === 'PUT').at(-1)?.body;
  async function save(label = 'Save AI connection', path = '/api/settings/ai') {
    await Promise.all([
      page.waitForResponse(
        (response) => new URL(response.url()).pathname === path && response.request().method() === 'PUT'
      ),
      nav(label).click()
    ]);
    await expect(nav(label)).toBeEnabled();
  }

  async function openAi() {
    await nav('Settings').click();
    await nav('AI features').click();
    await expect(nav('Save AI connection')).toBeVisible();
    if (!mode.demo) {
      await expect(nav('Save AI connection')).toBeEnabled();
    }
  }

  async function configure() {
    await page.getByLabel('AI provider', { exact: true }).selectOption('bedrock');
    await page.getByLabel('AWS region', { exact: true }).selectOption('ap-southeast-2');
    await page.getByLabel('AWS access key ID', { exact: true }).fill('AKIASYNTHETICONLY');
    await page.getByLabel('AWS secret access key', { exact: true }).fill('synthetic-shared-secret');
    await save();
  }

  async function ready() {
    for (const purpose of ['classification', 'assistant']) {
      await expect(choices(purpose)).toBeEnabled();
    }
  }

  try {
    await page.goto(base);
    await test({
      page,
      calls,
      mode,
      redbark,
      shared,
      features,
      responses,
      pending,
      release,
      nav,
      section,
      choices,
      count,
      lastWrite,
      save,
      openAi,
      configure,
      ready
    });
    await checkStorage();
    assert.deepEqual(errors, [], 'No browser exceptions');
    for (const response of responses) {
      assert(!response.includes('synthetic-shared-secret'), 'No secret returned in public responses');
    }

    evidence.push({
      name,
      result: 'passed',
      requests: calls.map(({ path, method, body }) => ({ path, method, fields: body ? Object.keys(body) : [] }))
    });
    console.log(`PASS ${name}`);
  } catch (error) {
    await page.screenshot({ path: `${output}/${name}-failure.png`, fullPage: true });
    evidence.push({ name, result: 'failed', error: error.message });
    throw error;
  } finally {
    for (const kind of Object.keys(pending)) {
      release(kind);
    }

    await page.close();
    await writeFile(
      `${output}/evidence.json`,
      JSON.stringify({ mockedApiResponses: true, cases: evidence }, null, 2) + '\n'
    );
  }
}

try {
  await scenario('subsections-navigation-keyboard-mobile', async ({ page, nav, calls, openAi }) => {
    await nav('Settings').click();
    await expect(page).toHaveURL(/#settings\/bank-feeds$/);
    await expect(page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link')).toHaveCount(6);
    await expect(page.getByLabel('Redbark API key', { exact: true })).toBeVisible();
    assert(
      !calls.some((call) =>
        ['/api/settings/ai', '/api/users', '/api/settings/notifications', '/api/import-health'].includes(call.path)
      ),
      'Inactive subsection does not mount or fetch'
    );
    await nav('Members').focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#settings\/members$/);
    await expect(page.getByLabel('Redbark API key', { exact: true })).toHaveCount(0);
    await expect(page.getByLabel('Invitation email address', { exact: true })).toBeVisible();
    await nav('Notifications').click();
    await expect(page.getByLabel('SMTP connection URL', { exact: true })).toBeVisible();
    await nav('Data').click();
    await expect(page.getByRole('heading', { name: 'Import health & history', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'SimpleFIN optional import', exact: true })).toHaveCount(0);
    await expect(page.getByRole('link', { name: /^Export/ })).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(/#settings\/notifications$/);
    await page.goForward();
    await expect(page).toHaveURL(/#settings\/data$/);
    await page.reload();
    await expect(page).toHaveURL(/#settings\/data$/);
    await expect(page.getByRole('heading', { name: 'Import health & history', exact: true })).toBeVisible();
    await openAi();
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      assert(
        await page.locator('body').evaluate((element) => element.scrollWidth <= innerWidth),
        `${width}px has no page overflow`
      );
      await page.screenshot({ path: `${output}/ai-${width}.png`, fullPage: true, animations: 'disabled' });
    }
  });

  await scenario('redbark-secrets-and-unsaved-navigation', async ({ page, nav, save, lastWrite, mode }) => {
    await nav('Settings').click();
    const key = page.getByLabel('Redbark API key', { exact: true });
    await key.fill('synthetic-redbark-key');
    mode.save = 'failure';
    await save('Save Redbark settings', '/api/settings/redbark');
    await expect(key).toHaveValue('synthetic-redbark-key');
    mode.save = 'success';
    await save('Save Redbark settings', '/api/settings/redbark');
    await expect(key).toHaveValue('');
    await save('Save Redbark settings', '/api/settings/redbark');
    assert(!Object.hasOwn(lastWrite('/api/settings/redbark'), 'apiKey'));
    await page.getByRole('checkbox', { name: 'Clear saved Redbark API key', exact: true }).check();
    await save('Save Redbark settings', '/api/settings/redbark');
    assert.equal(lastWrite('/api/settings/redbark').apiKey, null);
    await key.fill('synthetic-unsaved-secret');
    page.once('dialog', (dialog) => dialog.dismiss());
    await nav('AI features').click();
    await expect(page).toHaveURL(/#settings\/bank-feeds$/);
    await expect(key).toHaveValue('synthetic-unsaved-secret');
    page.once('dialog', (dialog) => dialog.dismiss());
    await nav('Overview').click();
    await expect(key).toHaveValue('synthetic-unsaved-secret');
    page.once('dialog', (dialog) => dialog.dismiss());
    await page.goBack();
    await expect(page).toHaveURL(/#settings\/bank-feeds$/);
    await expect(key).toHaveValue('synthetic-unsaved-secret');
    page.once('dialog', (dialog) => dialog.accept());
    await nav('AI features').click();
    await expect(page).toHaveURL(/#settings\/ai$/);
    await nav('Bank feeds').click();
    await expect(key).toHaveValue('');
  });

  await scenario(
    'one-openai-key-independent-features',
    async ({ page, nav, openAi, save, lastWrite, features, shared }) => {
      await openAi();
      await expect(page.getByLabel('OpenAI API key', { exact: true })).toHaveCount(1);
      await expect(page.getByLabel('Assistant OpenAI API key', { exact: true })).toHaveCount(0);
      await page.getByLabel('OpenAI API key', { exact: true }).fill('synthetic-shared-secret');
      await save();
      assert(!Object.hasOwn(lastWrite('/api/settings/ai'), 'model'));
      assert(!Object.hasOwn(lastWrite('/api/settings/ai'), 'region'));
      await expect(page.getByLabel('OpenAI API key', { exact: true })).toHaveValue('');
      await page.getByLabel('Classification model ID', { exact: true }).fill('synthetic-classifier');
      await page.getByRole('checkbox', { name: 'Enable AI classification', exact: true }).check();
      await page
        .getByRole('checkbox', { name: 'Automatically suggest categories for unresolved imports', exact: true })
        .check();
      for (const label of ['Requests per UTC day', 'Maximum import batch']) {
        await expect(page.getByLabel(label, { exact: true })).toHaveCount(0);
      }

      await page.getByRole('checkbox', { name: 'Also suggest categories for older transactions', exact: true }).check();
      await save('Save classification settings', '/api/settings/provider');
      await page.getByLabel('Assistant model ID', { exact: true }).fill('synthetic-assistant');
      await page.getByRole('checkbox', { name: /I understand authorized financial tool results/ }).check();
      await page.getByRole('checkbox', { name: 'Enable the household assistant', exact: true }).check();
      for (const label of [
        'Daily requests per user',
        'Tool calls per answer',
        'Model rounds per answer',
        'Maximum output tokens'
      ]) {
        await expect(page.getByLabel(label, { exact: true })).toHaveCount(0);
      }

      await save('Save assistant settings', '/api/settings/assistant');
      assert.equal(features.provider.model, 'synthetic-classifier');
      assert.equal(features.provider.includeHistory, true);
      assert.equal(Object.hasOwn(lastWrite('/api/settings/provider'), 'dailyRequestLimit'), false);
      assert.equal(Object.hasOwn(lastWrite('/api/settings/provider'), 'classifyFrom'), false);
      assert.equal(features.assistant.model, 'synthetic-assistant');
      for (const field of ['dailyRequestsPerUser', 'maxToolCalls', 'maxRounds', 'maxOutputTokens']) {
        assert.equal(Object.hasOwn(lastWrite('/api/settings/assistant'), field), false, field);
      }

      assert.equal(lastWrite('/api/settings/provider').aiRevision, shared.discoveryRevision);
      assert.equal(lastWrite('/api/settings/assistant').aiRevision, shared.discoveryRevision);
      await nav('Test saved connection').click();
      await expect(page.getByRole('status').filter({ hasText: 'Synthetic shared connection tested.' })).toBeVisible();
    }
  );

  await scenario(
    'shared-catalog-provider-groups-and-feature-saves',
    async ({ openAi, configure, ready, choices, count, section, save, features, nav }) => {
      await openAi();
      await configure();
      await ready();
      assert.equal(count(), 1);
      for (const purpose of ['classification', 'assistant']) {
        const key = purpose === 'classification' ? 'provider' : 'assistant';
        const group = section(purpose);
        await expect(group.getByRole('searchbox')).toHaveCount(0);
        await expect(group.getByRole('textbox')).toHaveCount(0);
        assert.deepEqual(
          await choices(purpose)
            .locator('optgroup')
            .evaluateAll((groups) => groups.map((item) => item.label)),
          ['Synthetic provider', 'Unknown provider']
        );
        const options = await choices(purpose).innerText();
        for (const label of [
          'Foundation model',
          'System inference profile',
          'Application inference profile',
          'LEGACY',
          'Unverified'
        ]) {
          assert(options.includes(label));
        }

        await choices(purpose).selectOption('synthetic-application-profile');
        await save(`Save ${purpose} settings`, `/api/settings/${key}`);
        assert.equal(features[key].model, 'synthetic-application-profile');
        assert.equal(features[key].enabled, false);
        assert.equal(count(), 1, 'Model-only saves retain the catalog without refetch');
      }

      // A saved model missing from the catalog stays selected and saves unchanged.
      features.provider.model = 'saved-unlisted-profile';
      await nav('Data').click();
      await nav('AI features').click();
      await ready();
      await expect(choices('classification')).toHaveValue('saved-unlisted-profile');
      assert((await choices('classification').innerText()).includes('saved-unlisted-profile · not in the loaded list'));
      await save('Save classification settings', '/api/settings/provider');
      assert.equal(features.provider.model, 'saved-unlisted-profile');
    }
  );

  await scenario(
    'catalog-error-retry-empty-and-partial',
    async ({ page, openAi, configure, ready, choices, count, section, mode, nav }) => {
      await openAi();
      mode.discovery = 'permission';
      await configure();
      for (const purpose of ['classification', 'assistant']) {
        await expect(section(purpose).getByRole('alert')).toContainText('Unable to load models');
      }

      const retry = section('classification').getByRole('button', { name: 'Retry loading models', exact: true });
      const start = count();
      await page.waitForTimeout(100);
      assert.equal(count(), start, 'Discovery failure does not create a retry loop');
      for (const response of ['stale', 'mismatch']) {
        mode.discovery = response;
        await retry.click();
        await expect(retry).toBeEnabled();
        await expect(section('assistant').getByRole('alert')).toContainText('Unable to load models');
      }

      mode.discovery = 'success';
      await retry.click();
      await ready();
      for (const response of ['partial', 'empty']) {
        mode.discovery = response;
        await nav('Data').click();
        await nav('AI features').click();
        if (response === 'partial') {
          await ready();
          await expect(section('classification').getByText('This list is incomplete.', { exact: false })).toBeVisible();
        } else {
          await expect(choices('classification')).toBeDisabled();
          await expect(
            section('classification').getByText('No matching models were returned.', { exact: false })
          ).toBeVisible();
        }
      }
    }
  );

  await scenario(
    'dirty-shared-credentials-cancel-catalog',
    async ({ page, openAi, configure, ready, choices, count }) => {
      await openAi();
      await configure();
      await ready();
      const key = page.getByLabel('AWS access key ID', { exact: true });
      const secret = page.getByLabel('AWS secret access key', { exact: true });
      const region = page.getByLabel('AWS region', { exact: true });
      const clear = page.getByRole('checkbox', { name: 'Clear saved AWS access key ID', exact: true });
      for (const field of ['key', 'secret', 'region', 'clear']) {
        const before = count();
        if (field === 'key') {
          await key.fill('synthetic-unsaved-key');
        }

        if (field === 'secret') {
          await secret.fill('synthetic-unsaved-secret');
        }

        if (field === 'region') {
          await region.selectOption('us-east-1');
        }

        if (field === 'clear') {
          await clear.check();
        }

        await expect(choices('classification')).toBeDisabled();
        await expect(choices('assistant')).toBeDisabled();
        assert.equal(count(), before);
        if (field === 'key') {
          await key.fill('');
        }

        if (field === 'secret') {
          await secret.fill('');
        }

        if (field === 'region') {
          await region.selectOption('ap-southeast-2');
        }

        if (field === 'clear') {
          await clear.uncheck();
        }

        await ready();
        assert.equal(count(), before + 1, 'Returning to clean saved identity reloads one shared catalog');
      }
    }
  );

  await scenario(
    'pending-catalog-feature-edits-and-connection',
    async ({ page, openAi, configure, ready, choices, count, mode, pending, release, nav }) => {
      await openAi();
      mode.discovery = 'deferred';
      await configure();
      await expect.poll(() => pending.discovery.length).toBe(1);
      await expect(choices('classification')).toBeDisabled();
      await page
        .getByRole('checkbox', { name: 'Automatically apply validated category suggestions', exact: true })
        .check();
      await nav('Test saved connection').click();
      await expect(nav('Test saved connection')).toBeEnabled();
      release('discovery');
      await ready();
      await choices('classification').selectOption('synthetic.text-v1');
      await expect(choices('classification')).toHaveValue('synthetic.text-v1');
      await expect(
        page.getByRole('checkbox', { name: 'Automatically apply validated category suggestions', exact: true })
      ).toBeChecked();
      assert.equal(count(), 1);
    }
  );

  await scenario(
    'stale-shared-discovery-and-section-unmount',
    async ({ page, openAi, configure, ready, choices, mode, pending, release, save, nav, count }) => {
      await openAi();
      mode.discovery = 'deferred';
      await configure();
      await expect.poll(() => pending.discovery.length).toBe(1);
      await page.getByLabel('AWS region', { exact: true }).selectOption('us-east-1');
      mode.discovery = 'success';
      await save();
      await ready();
      release('discovery');
      await expect(choices('classification')).toContainText('synthetic.text-v1');
      assert.equal(count(), 2);
      await nav('Data').click();
      mode.discovery = 'deferred';
      await nav('AI features').click();
      await expect.poll(() => pending.discovery.length).toBe(1);
      await nav('Notifications').click();
      mode.discovery = 'success';
      await nav('AI features').click();
      await ready();
      release('discovery');
      assert.equal(count(), 4);
    }
  );

  await scenario(
    'dirty-feature-revision-requires-explicit-reload',
    async ({ page, openAi, configure, ready, mode, section, save, features }) => {
      await openAi();
      await configure();
      await ready();
      const autoApply = page.getByRole('checkbox', {
        name: 'Automatically apply validated category suggestions',
        exact: true
      });
      await autoApply.check();
      await page.getByLabel('AWS secret access key', { exact: true }).fill('synthetic-rotated-secret');
      await save();
      await expect(autoApply).toBeChecked();
      await expect(page.getByRole('button', { name: 'Save classification settings', exact: true })).toBeDisabled();
      assert.equal(features.provider.autoApply, false);
      const reload = section('classification').getByRole('button', { name: 'Reload saved settings', exact: true });
      page.once('dialog', (dialog) => dialog.dismiss());
      await reload.click();
      await expect(autoApply).toBeChecked();
      page.once('dialog', (dialog) => dialog.accept());
      await reload.click();
      await expect(autoApply).not.toBeChecked();
      await expect(page.getByRole('button', { name: 'Save classification settings', exact: true })).toBeEnabled();
      mode.save = 'success';
    }
  );

  for (const outcome of ['deferred', 'deferred-failure']) {
    await scenario(
      `save-race-${outcome}`,
      async ({ openAi, configure, ready, choices, section, mode, pending, release, nav, calls }) => {
        await openAi();
        await configure();
        await ready();
        const model = choices('classification');
        await model.selectOption('synthetic.text-v1');
        mode.save = outcome;
        const before = calls.filter((call) => call.path === '/api/settings/provider' && call.method === 'PUT').length;
        await nav('Save classification settings').evaluate((element) => {
          element.click();
          element.click();
        });
        await expect.poll(() => pending.save.length).toBe(1);
        const autoApply = section('classification').getByRole('checkbox', {
          name: 'Automatically apply validated category suggestions',
          exact: true
        });
        await autoApply.check();
        release('save');
        await expect(autoApply).toBeChecked();
        await expect(model).toHaveValue('synthetic.text-v1');
        await expect(section('classification').getByText(/Your current changes are retained/)).toBeVisible();
        assert.equal(
          calls.filter((call) => call.path === '/api/settings/provider' && call.method === 'PUT').length,
          before + 1
        );
        if (outcome === 'deferred') {
          await expect(nav('Save classification settings')).toBeDisabled();
        }
      }
    );
  }

  await scenario(
    'shared-save-keeps-newer-secret-draft',
    async ({ page, openAi, mode, pending, release, nav, calls }) => {
      await openAi();
      await page.getByLabel('OpenAI API key', { exact: true }).fill('synthetic-submitted-key');
      mode.save = 'deferred';
      await nav('Save AI connection').evaluate((element) => {
        element.click();
        element.click();
      });
      await expect.poll(() => pending.save.length).toBe(1);
      await page.getByLabel('AI provider', { exact: true }).selectOption('bedrock');
      await page.getByLabel('AWS region', { exact: true }).selectOption('ap-southeast-2');
      await page.getByLabel('AWS access key ID', { exact: true }).fill('AKIANEWERDRAFT');
      await page.getByLabel('AWS secret access key', { exact: true }).fill('synthetic-newer-secret');
      release('save');
      await expect(page.getByLabel('AI provider', { exact: true })).toHaveValue('bedrock');
      await expect(page.getByLabel('AWS secret access key', { exact: true })).toHaveValue('synthetic-newer-secret');
      await expect(nav('Save AI connection')).toBeDisabled();
      assert.equal(
        calls.filter((call) => call.path === '/api/settings/ai' && call.method === 'PUT').length,
        1,
        'Repeated submit is fenced before controls disable'
      );
      const sharedSection = page.getByRole('region', { name: 'Shared AI connection', exact: true });
      page.once('dialog', (dialog) => dialog.accept());
      await sharedSection.getByRole('button', { name: 'Reload saved settings', exact: true }).click();
      await expect(page.getByLabel('AI provider', { exact: true })).toHaveValue('openai');
      await expect(page.getByLabel('OpenAI API key', { exact: true })).toHaveValue('');
    }
  );

  await scenario('refresh-signout-and-principal-isolation', async ({ page, mode, openAi, nav, calls }) => {
    await openAi();
    const key = page.getByLabel('OpenAI API key', { exact: true });
    await key.fill('synthetic-private-draft');
    let sawBeforeUnload = false;
    page.once('dialog', async (dialog) => {
      sawBeforeUnload = dialog.type() === 'beforeunload';
      await dialog.dismiss();
    });
    await page
      .reload({ timeout: 1500 })
      .catch((error) => assert.match(error.message, /ERR_ABORTED|Navigation.*cancelled|net::ERR|Timeout/));
    assert(sawBeforeUnload, 'Browser refresh warns before losing draft credentials');
    await expect(key).toHaveValue('synthetic-private-draft');
    page.once('dialog', (dialog) => dialog.dismiss());
    await nav('Sign out').click();
    await expect(key).toHaveValue('synthetic-private-draft');
    assert(!calls.some((call) => call.path === '/api/logout'), 'Cancelled signout does not end the session');
    page.once('dialog', (dialog) => dialog.accept());
    await nav('Sign out').click();
    await expect(page.getByRole('heading', { name: 'Welcome home.' })).toBeVisible();
    mode.role = 'member';
    const start = calls.length;
    await page.getByLabel('Email address', { exact: true }).fill('member@example.com');
    await page.getByLabel('Your password', { exact: true }).fill('synthetic-member-password');
    await nav('Sign in').click();
    await expect(nav('Sign out')).toBeVisible();
    await expect(key).toHaveCount(0);
    await expect(nav('Settings')).toHaveCount(0);
    assert(
      !calls.slice(start).some((call) => call.path.startsWith('/api/settings')),
      'New member identity cannot inherit the old AI form or requests'
    );
    await nav('Sign out').click();
    await expect(page.getByRole('heading', { name: 'Welcome home.' })).toBeVisible();
    mode.role = 'admin';
    await page.getByLabel('Email address', { exact: true }).fill('admin@example.com');
    await page.getByLabel('Your password', { exact: true }).fill('synthetic-admin-password');
    await nav('Sign in').click();
    await openAi();
    await expect(key).toHaveValue('');
  });

  await scenario('member-deeplink-and-demo-boundaries', async ({ page, mode, nav, openAi, calls }) => {
    mode.role = 'member';
    const before = calls.length;
    await page.goto(base + '/#settings/ai');
    await expect(nav('Settings')).toHaveCount(0);
    await expect(page.getByLabel('OpenAI API key', { exact: true })).toHaveCount(0);
    assert(
      !calls.slice(before).some((call) => call.path.startsWith('/api/settings/')),
      'Member deep link cannot fetch administrator forms'
    );
    mode.role = 'admin';
    mode.demo = true;
    await page.goto(base);
    await openAi();
    await expect(nav('Save AI connection')).toBeDisabled();
    await expect(nav('Save classification settings')).toBeDisabled();
    await expect(nav('Save assistant settings')).toBeDisabled();
  });
  console.log('Shared AI Settings race, routing, keyboard, responsive, secret and storage browser fixtures passed.');
} finally {
  await browser.close();
  await server.close();
}
