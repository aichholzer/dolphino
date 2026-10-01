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
  discoveryMode = 'success',
  saveMode = 'success';
const pendingDiscovery = [],
  pendingSave = [];
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
      assert.equal(
        body.provider === 'bedrock' && body.enabled && !body.model.trim(),
        false,
        'UI never sends enabled Bedrock with a blank model'
      );
      if (saveMode === 'deferred-failure') {
        await new Promise((resolve) => pendingSave.push(resolve));
        return route.fulfill({ status: 400, json: { error: 'Synthetic settings save failed' } });
      }
      if (saveMode === 'failure') {
        return route.fulfill({ status: 400, json: { error: 'Synthetic settings save failed' } });
      }
      savePublic(provider, body, ['apiKey', 'accessKeyId', 'secretAccessKey']);
      if (saveMode === 'deferred') {
        await new Promise((resolve) => pendingSave.push(resolve));
      }
    }
    data = provider;
  } else if (path === '/api/settings/assistant') {
    if (request.method() === 'PUT') {
      assert.equal(
        body.provider === 'bedrock' && body.enabled && !body.model.trim(),
        false,
        'UI never sends enabled Bedrock with a blank model'
      );
      if (saveMode === 'deferred-failure') {
        await new Promise((resolve) => pendingSave.push(resolve));
        return route.fulfill({ status: 400, json: { error: 'Synthetic settings save failed' } });
      }
      if (saveMode === 'failure') {
        return route.fulfill({ status: 400, json: { error: 'Synthetic settings save failed' } });
      }
      savePublic(assistant, body, ['apiKey', 'accessKeyId', 'secretAccessKey']);
      if (saveMode === 'deferred') {
        await new Promise((resolve) => pendingSave.push(resolve));
      }
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
  await page.getByRole('checkbox', { name: 'Enable the household assistant', exact: true }).check();
  await page.getByRole('checkbox', { name: /I understand authorized financial tool results/ }).check();
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
    const choices = section.getByLabel(`Available ${config.purpose} Bedrock models`, { exact: true });
    const search = section.getByLabel(`Search ${config.purpose} Bedrock models`, { exact: true });
    const key = section.getByLabel(config.keyLabel, { exact: true });
    const secret = section.getByLabel(config.secretLabel, { exact: true });
    const region = section.getByLabel(config.regionLabel, { exact: true });
    const providerSelect = section.getByLabel(config.providerLabel, { exact: true });
    const enable = section.getByRole('checkbox', { name: config.enableLabel, exact: true });
    const clear = section.getByRole('checkbox', { name: 'Clear saved value', exact: true }).first();
    const button = section.getByRole('button', { name: config.saveLabel, exact: true });
    const retry = section.getByRole('button', { name: 'Retry loading models', exact: true });
    const discoveryCount = () => calls.filter((call) => call.path === `${config.path}/models`).length;
    const save = async () => {
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
      await save();
      await expect(section.getByRole('status').filter({ hasText: 'choices returned' })).toBeVisible();
      await expect(choices.locator('option')).toHaveCount(mode === 'empty' ? 1 : 5);
    };
    const beginDeferred = async () => {
      discoveryMode = 'deferred';
      await save();
      await expect.poll(() => pendingDiscovery.length).toBe(1);
      await expect(choices).toBeDisabled();
    };
    const endDeferred = async ({ stale = true } = {}) => {
      const release = pendingDiscovery.shift();
      const count = responses.length;
      release();
      await expect.poll(() => responses.length).toBeGreaterThan(count);
      if (stale) {
        await expect(choices).toBeDisabled();
        await expect(choices.locator('option')).toHaveCount(1);
      }
    };

    // An enabled OpenAI configuration can switch to Bedrock and save keys with
    // no model. The dropdown is primary and manual input is only an optional fallback.
    await expect(enable).toBeChecked();
    await providerSelect.selectOption('bedrock');
    await region.selectOption('ap-southeast-2');
    await expect(choices).toBeVisible();
    await expect(choices).toBeDisabled();
    await expect(choices).toContainText('Save settings to load models');
    await expect(model).toBeHidden();
    await section.getByText('Enter a model or inference profile ID manually (optional)', { exact: true }).click();
    await expect(model).toHaveValue('');
    assert.equal(await model.evaluate((element) => element.required), false, 'blank Bedrock model never blocks Save');
    await expect(enable).not.toBeChecked();
    await expect(enable).toBeDisabled();
    await key.fill(`synthetic-${config.purpose}-access-key`);
    await secret.fill(`synthetic-${config.purpose}-secret-key`);
    const firstDiscovery = discoveryCount();
    await loadSuccessful();
    assert.equal(discoveryCount(), firstDiscovery + 1, 'ordinary Save automatically loads choices once');
    assert.equal(lastWrite(config.path).model, '', 'actual submit saves credentials before choosing a model');
    assert.equal(lastWrite(config.path).enabled, false, 'incomplete configuration is persisted disabled');
    assert.equal(config.target.configured, false);
    assert.equal(config.target.credentials.accessKeyId.configured, true);
    assert.equal(config.target.credentials.secretAccessKey.configured, true);
    await expect(model).toHaveValue('');
    await expect(enable).toBeDisabled();
    await expect(page.getByRole('status').filter({ hasText: 'Credentials and settings saved.' })).toBeVisible();
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
    await expect(enable).not.toBeChecked();
    await loadSuccessful();
    assert.equal(lastWrite(config.path).enabled, false, 'selecting and saving never auto-enables');
    await enable.check();
    await loadSuccessful();
    assert.equal(lastWrite(config.path).enabled, true, 'explicit enable works after selection');
    await model.fill('');
    await expect(enable).not.toBeChecked();
    await expect(enable).toBeDisabled();
    await loadSuccessful();
    assert.equal(lastWrite(config.path).enabled, false, 'clearing an enabled model saves a disabled configuration');
    assert.equal(lastWrite(config.path).model, '');
    await expect(model).toHaveValue('');

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
      await key.fill(`synthetic-${config.purpose}-access-key`);
      await save();
      await expect(section.getByRole('alert')).toContainText('Unable to load models');
      await expect(section.getByRole('alert')).toContainText('bedrock:ListInferenceProfiles');
      await expect(section.getByRole('alert')).toContainText('saved settings and credentials are retained');
      await expect(choices).toBeDisabled();
      await expect(model).toHaveValue('synthetic.legacy-v1');
      await expect(model).toBeEditable();
      assert.equal(config.target.credentials.accessKeyId.configured, true);
      const puts = calls.filter((call) => call.path === config.path && call.method === 'PUT').length;
      discoveryMode = 'success';
      await retry.click();
      await expect(choices).toBeEnabled();
      assert.equal(
        calls.filter((call) => call.path === config.path && call.method === 'PUT').length,
        puts,
        'retry uses saved credentials without re-entry or another save'
      );
    }

    // A failed save does not start discovery or discard write-only draft keys.
    saveMode = 'failure';
    await key.fill('synthetic-retry-draft');
    const beforeFailedSave = discoveryCount();
    await button.click();
    await expect(page.getByRole('alert').filter({ hasText: 'Synthetic settings save failed' })).toBeVisible();
    await expect(key).toHaveValue('synthetic-retry-draft');
    assert.equal(discoveryCount(), beforeFailedSave);
    saveMode = 'success';
    await loadSuccessful();

    // Any unsaved credential, clear or region change invalidates existing choices.
    await key.fill('synthetic-unsaved-key');
    await expect(choices).toBeDisabled();
    await expect(choices.locator('option')).toHaveCount(1);
    await key.fill('');
    await clear.check();
    await expect(choices).toBeDisabled();
    await clear.uncheck();
    await region.selectOption('us-east-1');
    await region.selectOption('ap-southeast-2');
    await expect(choices).toBeDisabled();

    // Double Save and double Retry are fenced before React disables controls.
    discoveryMode = 'deferred';
    const beforeDouble = discoveryCount();
    await button.evaluate((element) => {
      element.click();
      element.click();
    });
    await expect.poll(() => pendingDiscovery.length).toBe(1);
    assert.equal(discoveryCount(), beforeDouble + 1);
    await model.fill('manual-model-after-request');
    await endDeferred();
    await expect(model).toHaveValue('manual-model-after-request');
    discoveryMode = 'permission';
    await save();
    await expect(retry).toBeEnabled();
    discoveryMode = 'deferred';
    const beforeRetry = discoveryCount();
    await retry.evaluate((element) => {
      element.click();
      element.click();
    });
    await expect.poll(() => pendingDiscovery.length).toBe(1);
    assert.equal(discoveryCount(), beforeRetry + 1);
    await model.fill('second-manual-model');
    await endDeferred();

    await beginDeferred();
    await enable.check();
    await endDeferred();
    await enable.uncheck();
    await beginDeferred();
    await secret.fill('synthetic-unsaved-secret');
    await endDeferred();
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
    await loadSuccessful();
    await endDeferred({ stale: false });
    await expect(choices).toBeEnabled();
    await expect(model).toHaveValue('second-manual-model');
    await beginDeferred();
    await providerSelect.selectOption('openai');
    await providerSelect.selectOption('bedrock');
    await endDeferred();
    await expect(model).toHaveValue('');
    await section.getByText('Enter a model or inference profile ID manually (optional)', { exact: true }).click();

    // Late PUT responses cannot overwrite newer region, provider or credential
    // edits, and cannot launch discovery with the stale response's revision.
    for (const change of ['region', 'provider', 'credentials']) {
      saveMode = 'deferred';
      const beforeStaleSave = discoveryCount();
      await button.click();
      await expect.poll(() => pendingSave.length).toBe(1);
      if (change === 'region') {
        await region.selectOption('us-east-1');
      } else if (change === 'provider') {
        await providerSelect.selectOption('openai');
      } else {
        await key.fill('synthetic-newer-draft');
      }
      pendingSave.shift()();
      await expect(button).toBeEnabled();
      await expect(page.getByRole('status').filter({ hasText: 'form changed while saving' })).toBeVisible();
      assert.equal(discoveryCount(), beforeStaleSave, 'stale save response never starts discovery');
      if (change === 'region') {
        await expect(region).toHaveValue('us-east-1');
        await region.selectOption('ap-southeast-2');
      } else if (change === 'provider') {
        await expect(providerSelect).toHaveValue('openai');
        await providerSelect.selectOption('bedrock');
        await section.getByText('Enter a model or inference profile ID manually (optional)', { exact: true }).click();
      } else {
        await expect(key).toHaveValue('synthetic-newer-draft');
      }
      saveMode = 'success';
      await loadSuccessful();
    }
    saveMode = 'deferred-failure';
    const beforeStaleFailure = discoveryCount();
    await button.click();
    await expect.poll(() => pendingSave.length).toBe(1);
    await key.fill('synthetic-newer-draft');
    pendingSave.shift()();
    await expect(
      page.getByRole('alert').filter({ hasText: 'Settings were not saved. Your current changes are retained' })
    ).toBeVisible();
    await expect(key).toHaveValue('synthetic-newer-draft');
    assert.equal(discoveryCount(), beforeStaleFailure);
    saveMode = 'success';
    await model.fill('saved-manual-profile');
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
  discoveryMode = 'deferred';
  await page.getByRole('button', { name: 'Save provider settings', exact: true }).click();
  await expect.poll(() => pendingDiscovery.length).toBe(1);
  await page.getByRole('button', { name: 'Save assistant settings', exact: true }).click();
  await expect.poll(() => pendingDiscovery.length).toBe(2);
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  while (pendingDiscovery.length) {
    pendingDiscovery.shift()();
  }
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByLabel(/Available .* Bedrock models/)).toHaveCount(2);
  for (const select of await page.getByLabel(/Available .* Bedrock models/).all()) {
    await expect(select).toBeDisabled();
  }
  await expect(page.getByRole('button', { name: 'Load models', exact: true })).toHaveCount(0);

  // An unmounted save does not launch discovery when its response arrives.
  saveMode = 'deferred';
  const beforeUnmountedSave = calls.filter((call) => call.path.endsWith('/models')).length;
  await page.getByRole('button', { name: 'Save provider settings', exact: true }).click();
  await expect.poll(() => pendingSave.length).toBe(1);
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  const beforeRelease = responses.length;
  pendingSave.shift()();
  await expect.poll(() => responses.length).toBeGreaterThan(beforeRelease);
  assert.equal(calls.filter((call) => call.path.endsWith('/models')).length, beforeUnmountedSave);
  saveMode = 'success';
  discoveryMode = 'success';

  // Unusable saved credentials and demo mode cannot issue discovery requests.
  provider.credentialsAvailable = false;
  assistant.credentialsAvailable = false;
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const beforeUnusable = calls.filter((call) => call.path.endsWith('/models')).length;
  for (const label of ['Save provider settings', 'Save assistant settings']) {
    await page.getByRole('button', { name: label, exact: true }).click();
    await expect(page.getByRole('button', { name: label, exact: true })).toBeEnabled();
  }
  assert.equal(calls.filter((call) => call.path.endsWith('/models')).length, beforeUnusable);
  provider.credentialsAvailable = true;
  assistant.credentialsAvailable = true;
  demo = true;
  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByText('Model discovery is unavailable in the fictional demo.', { exact: true })).toHaveCount(2);
  for (const label of ['Save provider settings', 'Save assistant settings']) {
    await expect(page.getByRole('button', { name: label, exact: true })).toBeDisabled();
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
    'synthetic-unsaved-secret',
    'synthetic-retry-draft',
    'synthetic-newer-draft'
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
    'Database Settings browser checks passed: Redbark write-only save/preserve/clear, signing-secret controls, failed-save retry, OpenAI first save, independent classification flags/limits, Bedrock ordinary-save automatic discovery and model-free setup for classification and assistant, searchable foundation/profile choices, manual/legacy preservation, empty/partial results, permission/stale failures, dirty drafts, failed-save and failed-discovery retries, repeated Save/Retry, stale PUT and region/provider/save/refresh/unmount races, demo controls, no inference, no secret disclosure, webhook registration and responsive layout. All APIs mocked.'
  );
} finally {
  await browser.close();
}
