import { installBrowserStorageGuard } from './browser-storage-guard.mjs';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';

// Run against the Vite frontend. Every API is intercepted; no provider calls,
// credentials, database, or external account is required.
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
  args: ['--no-sandbox']
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const assertPageStorageUnused = await installBrowserStorageGuard(page);
const calls = [],
  errors = [],
  responses = [];
let revision = 0;
const nextRevision = () => (++revision).toString(16).padStart(64, '0');
page.on('pageerror', (error) => errors.push(error.message));
const credential = (configured = false) => ({
  configured,
  masked: configured ? '••••••••' : ''
});
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
const provider = {
  discoveryRevision: nextRevision(),
  provider: 'openai',
  model: '',
  region: '',
  enabled: false,
  autoClassify: false,
  autoApply: false,
  dailyRequestLimit: 20,
  batchSize: 5,
  encryptionAvailable: true,
  credentialsAvailable: true,
  configured: false,
  credentials: {
    apiKey: credential(),
    accessKeyId: credential(),
    secretAccessKey: credential()
  },
  regionCatalog: {
    regions: [
      { id: 'ap-southeast-2', label: 'Sydney' },
      { id: 'us-east-1', label: 'Northern Virginia' }
    ]
  }
};
const assistant = {
  discoveryRevision: nextRevision(),
  provider: 'openai',
  model: '',
  region: '',
  enabled: false,
  dataSharingAcknowledged: false,
  dailyRequestsPerUser: 10,
  maxToolCalls: 4,
  maxRounds: 3,
  maxOutputTokens: 1024,
  encryptionAvailable: true,
  credentialsAvailable: true,
  credentials: {},
  regionCatalog: provider.regionCatalog
};
let failSave = false,
  demo = false,
  discoveryMode = 'success';
const pendingDiscovery = [];
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
function savePublic(target, body, names) {
  for (const [key, value] of Object.entries(body)) {
    if (names.includes(key)) {
      if (value !== '') {
        target.credentials[key] = credential(value !== null);
      }
    } else {
      target[key] = value;
    }
  }
  if (target.provider) {
    target.discoveryRevision = nextRevision();
    target.configured = !!target.model;
  }
}
await page.route('**/api/**', async (route) => {
  const request = route.request();
  const path = new URL(request.url()).pathname;
  const body = request.postDataJSON();
  calls.push({ path, method: request.method(), body });
  let data = {},
    status = 200;
  if (path === '/api/session') {
    data = {
      authenticated: true,
      demo,
      currency: 'AUD',
      timeZone: 'Australia/Brisbane',
      user: {
        id: 'admin',
        name: 'Synthetic administrator',
        email: 'admin@example.com',
        role: 'admin'
      }
    };
  } else if (path === '/api/dashboard') {
    data = { incomeMinor: '0', expensesMinor: '0', netMinor: '0' };
  } else if (path === '/api/settings') {
    data = {
      redbark: { configured: redbark.configured, version: redbark.version }
    };
  } else if (path === '/api/settings/redbark') {
    if (request.method() === 'PUT') {
      if (failSave) {
        data = { error: 'Invalid Redbark settings' };
        status = 400;
      } else {
        savePublic(redbark, body, ['apiKey', 'signingSecret']);
        redbark.configured = redbark.credentials.apiKey.configured;
        redbark.signingSecretAssociated = redbark.credentials.signingSecret.configured;
      }
    }
    if (status === 200) {
      data = redbark;
    }
  } else if (path === '/api/settings/provider/models' || path === '/api/settings/assistant/models') {
    const target = path.includes('/assistant/') ? assistant : provider;
    assert.deepEqual(body, { revision: target.discoveryRevision }, 'discovery sends only saved revision');
    data = {
      revision: target.discoveryRevision,
      region: target.region,
      models: discoveryMode === 'empty' ? [] : models,
      warnings: ['Model access and compatibility have not been verified.'],
      truncated: discoveryMode === 'partial'
    };
    if (discoveryMode === 'permission') {
      status = 403;
      data = { error: 'Bedrock discovery permission denied.' };
    } else if (discoveryMode === 'stale') {
      status = 409;
      data = { error: 'Saved configuration changed. Refresh settings.' };
    } else if (discoveryMode === 'mismatch') {
      data.revision = 'f'.repeat(64);
    } else if (discoveryMode === 'deferred') {
      await new Promise((resolve) => pendingDiscovery.push(resolve));
    }
  } else if (path === '/api/settings/provider') {
    if (request.method() === 'PUT') {
      savePublic(provider, body, ['apiKey', 'accessKeyId', 'secretAccessKey']);
    }
    data = provider;
  } else if (path === '/api/settings/assistant') {
    if (request.method() === 'PUT') {
      savePublic(assistant, body, ['apiKey', 'accessKeyId', 'secretAccessKey']);
    }
    data = assistant;
  } else if (path === '/api/settings/webhook') {
    data = {
      state: 'registered',
      destinationId: 'synthetic-destination',
      publicBaseUrl: 'https://dolphino.example.com'
    };
  } else if (path === '/api/settings/webhook/register') {
    data = { message: 'Synthetic registration reused' };
  } else if (path === '/api/settings/notifications') {
    data = { smtp: {}, telegram: {} };
  } else if (path === '/api/notifications/deliveries') {
    data = [];
  } else if (path === '/api/users') {
    data = { users: [], invitations: [] };
  } else if (path === '/api/users/grant-options') {
    data = { accounts: [], budgets: [] };
  } else if (path === '/api/import-health') {
    data = { accounts: [], jobs: [] };
  }
  responses.push(JSON.stringify(data));
  await route.fulfill({ status, json: data });
});
const lastWrite = (path) => calls.filter((c) => c.path === path && c.method === 'PUT').at(-1)?.body;
const saveRedbark = async () => {
  await page.getByRole('button', { name: 'Save Redbark settings', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Redbark settings saved' }).waitFor();
  await expect(page.getByRole('button', { name: 'Save Redbark settings', exact: true })).toBeEnabled();
};
try {
  await page.goto(process.env.DOLPHINO_TEST_URL || 'http://127.0.0.1:5173');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Redbark API key', { exact: true }).fill('synthetic-redbark-key');
  await page.getByLabel('Redbark API version', { exact: true }).fill('2026-10-02.wattle');
  await page.getByLabel('Rolling backfill days', { exact: true }).fill('180');
  await saveRedbark();
  assert.deepEqual(lastWrite('/api/settings/redbark'), {
    version: '2026-10-02.wattle',
    backfillDays: 180,
    apiKey: 'synthetic-redbark-key'
  });
  assert.equal(await page.getByLabel('Redbark API key', { exact: true }).inputValue(), '');
  await saveRedbark();
  assert.equal(Object.hasOwn(lastWrite('/api/settings/redbark'), 'apiKey'), false, 'blank preserves key');
  await page.getByText('Existing destination signing secret', { exact: true }).click();
  await page.getByLabel('Redbark signing secret', { exact: true }).fill('synthetic-signing-secret');
  await saveRedbark();
  assert.equal(lastWrite('/api/settings/redbark').signingSecret, 'synthetic-signing-secret');
  assert.equal(await page.getByLabel('Redbark signing secret', { exact: true }).inputValue(), '');
  await page
    .getByRole('checkbox', {
      name: 'Clear saved Redbark signing secret',
      exact: true
    })
    .check();
  await saveRedbark();
  assert.equal(lastWrite('/api/settings/redbark').signingSecret, null);
  await page.getByRole('checkbox', { name: 'Clear saved Redbark API key', exact: true }).check();
  await saveRedbark();
  assert.equal(lastWrite('/api/settings/redbark').apiKey, null);
  failSave = true;
  await page.getByLabel('Redbark API key', { exact: true }).fill('synthetic-retry-key');
  await page.getByRole('button', { name: 'Save Redbark settings', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Invalid Redbark settings' }).waitFor();
  assert.equal(
    await page.getByLabel('Redbark API key', { exact: true }).inputValue(),
    'synthetic-retry-key',
    'failed save retains draft'
  );
  failSave = false;
  await saveRedbark();
  await page.getByLabel('Model', { exact: true }).fill('synthetic-model');
  await page.getByLabel('OpenAI API key', { exact: true }).fill('synthetic-openai-key');
  await page.getByRole('checkbox', { name: 'Enable AI classification', exact: true }).check();
  await page.getByRole('button', { name: 'Save provider settings', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Settings updated.' }).waitFor();
  let body = lastWrite('/api/settings/provider');
  assert.equal(Object.hasOwn(body, 'region'), false, 'OpenAI first save omits blank Bedrock region');
  assert.equal(body.enabled, true);
  assert.equal(body.autoClassify, false, 'on-demand only supported');
  assert.equal(body.autoApply, false);
  await expect(page.getByLabel('OpenAI API key', { exact: true })).toHaveValue('');
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
  await page.getByRole('button', { name: 'Save provider settings', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Settings updated.' }).waitFor();
  body = lastWrite('/api/settings/provider');
  assert.equal(body.autoClassify, true);
  assert.equal(body.autoApply, true);
  assert.equal(body.dailyRequestLimit, 30);
  assert.equal(body.batchSize, 6);
  assert.equal(Object.hasOwn(body, 'apiKey'), false, 'blank LLM key preserves saved value');
  await page.getByLabel('Assistant model ID', { exact: true }).fill('synthetic-assistant');
  await page.getByLabel('Assistant OpenAI API key', { exact: true }).fill('synthetic-assistant-key');
  await page.getByRole('button', { name: 'Save assistant settings', exact: true }).click();
  await page.getByText('Assistant settings saved.', { exact: true }).waitFor();
  assert.equal(Object.hasOwn(lastWrite('/api/settings/assistant'), 'region'), false);
  await page.getByRole('button', { name: 'Register / reuse destination', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Thin-event notifications registered/reused' }).waitFor();
  assert(
    calls.some(
      (c) => c.path === '/api/settings/webhook/register' && c.body.publicBaseUrl === 'https://dolphino.example.com'
    )
  );
  const pickerCases = [
    {
      heading: 'Optional AI classification',
      purpose: 'classification',
      providerLabel: 'Provider',
      modelLabel: 'Model or inference profile ID / ARN',
      regionLabel: 'AWS region',
      keyLabel: 'AWS access key ID',
      secretLabel: 'AWS secret access key',
      saveLabel: 'Save provider settings',
      enableLabel: 'Enable AI classification',
      path: '/api/settings/provider',
      target: provider
    },
    {
      heading: 'Read-only financial assistant',
      purpose: 'assistant',
      providerLabel: 'Assistant provider',
      modelLabel: 'Assistant model ID',
      regionLabel: 'Assistant AWS region',
      keyLabel: 'Assistant AWS access key ID',
      secretLabel: 'Assistant AWS secret access key',
      saveLabel: 'Save assistant settings',
      enableLabel: 'Enable the household assistant',
      path: '/api/settings/assistant',
      target: assistant
    }
  ];
  for (const config of pickerCases) {
    const section = page
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: config.heading, exact: true }) });
    const model = section.getByLabel(config.modelLabel, { exact: true });
    const load = section.getByRole('button', { name: /^(Load models|Loading models…)$/ });
    const choices = section.getByLabel(`Available ${config.purpose} Bedrock models`, { exact: true });
    const search = section.getByLabel(`Search ${config.purpose} Bedrock models`, { exact: true });
    const key = section.getByLabel(config.keyLabel, { exact: true });
    const secret = section.getByLabel(config.secretLabel, { exact: true });
    const region = section.getByLabel(config.regionLabel, { exact: true });
    const clear = section.getByRole('checkbox', { name: 'Clear saved value', exact: true }).first();
    const save = async () => {
      const button = section.getByRole('button', { name: config.saveLabel, exact: true });
      await Promise.all([
        page.waitForResponse(
          (response) => response.url().endsWith(config.path) && response.request().method() === 'PUT'
        ),
        button.click()
      ]);
      await expect(button).toBeEnabled();
      await expect(key).toHaveValue('');
      await expect(secret).toHaveValue('');
    };
    const loadSuccessful = async (mode = 'success') => {
      discoveryMode = mode;
      await load.click();
      await expect(choices).toBeVisible();
      await expect(load).toBeEnabled();
    };
    const beginDeferred = async () => {
      discoveryMode = 'deferred';
      await load.click();
      await expect.poll(() => pendingDiscovery.length).toBe(1);
      await expect(load).toBeDisabled();
    };
    const endDeferred = async () => {
      const release = pendingDiscovery.shift();
      const count = responses.length;
      release();
      await expect.poll(() => responses.length).toBeGreaterThan(count);
      await expect(choices).toHaveCount(0);
    };

    await section.getByLabel(config.providerLabel, { exact: true }).selectOption('bedrock');
    await region.selectOption('ap-southeast-2');
    await expect(model).toHaveValue('');
    assert.equal(await model.evaluate((element) => element.required), false, 'disabled Bedrock permits missing model');
    await key.fill(`synthetic-${config.purpose}-access-key`);
    await secret.fill(`synthetic-${config.purpose}-secret-key`);
    await expect(load).toBeDisabled();
    await save();
    assert.equal(lastWrite(config.path).model, '', 'credentials can be saved before choosing a model');
    assert.equal(lastWrite(config.path).enabled, false, 'provider switch requires re-enable');
    assert.equal(config.target.configured, false, 'empty model remains unconfigured');
    await expect(load).toBeEnabled();
    await section.getByRole('checkbox', { name: config.enableLabel, exact: true }).check();
    assert.equal(await model.evaluate((element) => element.required), true, 'enabled Bedrock requires a model');
    await section.getByRole('checkbox', { name: config.enableLabel, exact: true }).uncheck();
    await loadSuccessful();
    await expect(model).toHaveValue('');
    assert.deepEqual(calls.filter((call) => call.path === `${config.path}/models`).at(-1).body, {
      revision: config.target.discoveryRevision
    });
    const optionText = (await choices.locator('option').allTextContents()).join(' ');
    for (const description of [
      'Foundation model',
      'System inference profile',
      'Application inference profile',
      'LEGACY',
      'Unverified'
    ]) {
      assert(optionText.includes(description), `discovery labels ${description}`);
    }
    await search.fill('Household');
    await expect(choices.locator('option')).toHaveCount(2);
    await choices.selectOption('synthetic-application-profile');
    await expect(model).toHaveValue('synthetic-application-profile');
    await save();
    await expect(choices).toHaveCount(0);
    await model.fill('custom.model-or-profile');
    await loadSuccessful();
    await expect(model).toHaveValue('custom.model-or-profile');
    await search.fill('Legacy');
    await choices.selectOption('synthetic.legacy-v1');
    await loadSuccessful();
    await expect(model).toHaveValue('synthetic.legacy-v1');
    await loadSuccessful('partial');
    await expect(section.getByText('This list is incomplete.', { exact: false })).toBeVisible();
    await loadSuccessful('empty');
    await expect(choices).toBeDisabled();
    await expect(model).toHaveValue('synthetic.legacy-v1');
    for (const mode of ['permission', 'stale', 'mismatch']) {
      discoveryMode = mode;
      await load.click();
      await expect(section.getByRole('alert')).toContainText('Unable to load models');
      await expect(section.getByRole('alert')).toContainText('bedrock:ListInferenceProfiles');
      await expect(choices).toHaveCount(0);
      await expect(model).toHaveValue('synthetic.legacy-v1');
      await expect(model).toBeEditable();
    }
    await loadSuccessful();
    await key.fill('synthetic-unsaved-key');
    await expect(load).toBeDisabled();
    await expect(choices).toHaveCount(0);
    await key.fill('');
    await expect(load).toBeEnabled();
    await clear.check();
    await expect(load).toBeDisabled();
    await clear.uncheck();
    await region.selectOption('us-east-1');
    await expect(load).toBeDisabled();
    await region.selectOption('ap-southeast-2');
    await expect(load).toBeEnabled();

    // Double dispatch happens before React can repaint the disabled button.
    discoveryMode = 'deferred';
    const beforeDouble = calls.filter((call) => call.path === `${config.path}/models`).length;
    await load.evaluate((element) => {
      element.click();
      element.click();
    });
    await expect.poll(() => pendingDiscovery.length).toBe(1);
    assert.equal(calls.filter((call) => call.path === `${config.path}/models`).length, beforeDouble + 1);
    await model.fill('manual-model-after-request');
    await endDeferred();
    await expect(model).toHaveValue('manual-model-after-request');

    await beginDeferred();
    await section.getByRole('checkbox', { name: config.enableLabel, exact: true }).check();
    await endDeferred();
    await section.getByRole('checkbox', { name: config.enableLabel, exact: true }).uncheck();
    await beginDeferred();
    await secret.fill('synthetic-unsaved-secret');
    await endDeferred();
    await expect(load).toBeDisabled();
    await secret.fill('');
    await beginDeferred();
    await clear.check();
    await endDeferred();
    await clear.uncheck();
    await beginDeferred();
    await region.selectOption('us-east-1');
    await region.selectOption('ap-southeast-2');
    await endDeferred();
    await beginDeferred();
    await save();
    await endDeferred();
    await expect(model).toHaveValue('manual-model-after-request');
    await beginDeferred();
    await section.getByLabel(config.providerLabel, { exact: true }).selectOption('openai');
    await section.getByLabel(config.providerLabel, { exact: true }).selectOption('bedrock');
    await endDeferred();
    await expect(model).toHaveValue('');
    await model.fill('saved-manual-profile');
    await save();
    await loadSuccessful();
    await expect(model).toHaveValue('saved-manual-profile');
    if (process.env.DOLPHINO_BROWSER_ARTIFACT_DIR) {
      await mkdir(process.env.DOLPHINO_BROWSER_ARTIFACT_DIR, { recursive: true });
      await choices.selectOption('apac.synthetic.text-v1');
      for (const [size, viewport] of [
        ['desktop', { width: 1440, height: 1000 }],
        ['mobile', { width: 390, height: 844 }]
      ]) {
        await page.setViewportSize(viewport);
        assert.equal(
          await page.locator('body').evaluate((element) => element.scrollWidth <= innerWidth),
          true,
          `${config.purpose} loaded picker ${size} overflow`
        );
        await section.screenshot({
          path: join(process.env.DOLPHINO_BROWSER_ARTIFACT_DIR, `bedrock-${config.purpose}-${size}.png`),
          animations: 'disabled'
        });
      }
      await page.setViewportSize({ width: 1440, height: 1000 });
      await model.fill('saved-manual-profile');
    }
    if (config.purpose === 'assistant') {
      await expect(section.getByText('the assistant also requires tool use', { exact: false })).toBeVisible();
    } else {
      await beginDeferred();
      await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
      await expect(page.getByRole('status').filter({ hasText: 'Registration status refreshed.' })).toBeVisible();
      await endDeferred();
    }
  }

  // Unmounting Settings disposes of both discoveries. Returning starts clean.
  const bothLoad = page.getByRole('button', { name: 'Load models', exact: true });
  discoveryMode = 'deferred';
  await bothLoad.nth(0).click();
  await bothLoad.nth(0).click();
  await expect.poll(() => pendingDiscovery.length).toBe(2);
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  while (pendingDiscovery.length) {
    pendingDiscovery.shift()();
  }
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByLabel(/Available .* Bedrock models/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Load models', exact: true })).toHaveCount(2);

  // Unusable saved credentials and demo mode cannot issue discovery requests.
  provider.credentialsAvailable = false;
  assistant.credentialsAvailable = false;
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  for (const button of await page.getByRole('button', { name: 'Load models', exact: true }).all()) {
    await expect(button).toBeDisabled();
  }
  provider.credentialsAvailable = true;
  assistant.credentialsAvailable = true;
  demo = true;
  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByText('Model discovery is unavailable in the fictional demo.', { exact: true })).toHaveCount(2);
  for (const button of await page.getByRole('button', { name: 'Load models', exact: true }).all()) {
    await expect(button).toBeDisabled();
  }
  const discoveryCalls = calls.filter((call) => call.path.endsWith('/models'));
  assert(discoveryCalls.length > 0);
  assert(discoveryCalls.every((call) => call.method === 'POST' && Object.keys(call.body).join() === 'revision'));
  const publicResponses = responses.join(' ');
  for (const secret of [
    'synthetic-classification-access-key',
    'synthetic-classification-secret-key',
    'synthetic-assistant-access-key',
    'synthetic-assistant-secret-key',
    'synthetic-unsaved-key',
    'synthetic-unsaved-secret'
  ]) {
    assert.equal(publicResponses.includes(secret), false, 'API responses never return write-only credentials');
    assert.equal(
      (await page.locator('body').innerText()).includes(secret),
      false,
      'credentials are absent from rendered content'
    );
  }
  assert.equal(
    calls.some((call) => /test-model|test-connection/.test(call.path)),
    false,
    'model discovery never invokes connection or inference tests'
  );
  assert.equal(await page.locator('body').evaluate((element) => element.scrollWidth <= innerWidth), true);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.locator('body').evaluate((element) => element.scrollWidth <= innerWidth),
    true,
    'mobile Settings overflow'
  );
  assert.deepEqual(errors, []);
  await assertPageStorageUnused();
  console.log(
    'Database Settings browser checks passed: Redbark write-only save/preserve/clear, signing-secret controls, failed-save retry, OpenAI first save, independent classification flags/limits, Bedrock credentials-first discovery for classification and assistant, searchable foundation/profile choices, manual/legacy preservation, empty/partial results, permission/stale failures, dirty drafts, repeated requests, region/provider/save/refresh/unmount races, demo controls, no inference, no secret disclosure, webhook registration and responsive layout. All APIs mocked.'
  );
} finally {
  await browser.close();
}
