import { installBrowserStorageGuard } from './browser-storage-guard.mjs';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

// Run against the Vite frontend. Every API is intercepted; no provider calls,
// credentials, database, or external account is required.
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
  args: ['--no-sandbox']
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const assertPageStorageUnused = await installBrowserStorageGuard(page);
const calls = [],
  errors = [];
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
  regionCatalog: { regions: [{ id: 'ap-southeast-2', label: 'Sydney' }] }
};
const assistant = {
  provider: 'openai',
  model: '',
  region: '',
  enabled: false,
  dataSharingAcknowledged: false,
  dailyRequestsPerUser: 10,
  maxToolCalls: 4,
  maxRounds: 3,
  maxOutputTokens: 1024,
  credentials: {}
};
let failSave = false;
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
      demo: false,
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
  } else if (path === '/api/settings/provider') {
    if (request.method() === 'PUT') {
      savePublic(provider, body, ['apiKey', 'accessKeyId', 'secretAccessKey']);
    }
    data = provider;
  } else if (path === '/api/settings/assistant') {
    if (request.method() === 'PUT') {
      savePublic(assistant, body, ['apiKey']);
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
  await route.fulfill({ status, json: data });
});
const lastWrite = (path) => calls.filter((c) => c.path === path && c.method === 'PUT').at(-1)?.body;
const saveRedbark = async () => {
  await page.getByRole('button', { name: 'Save Redbark settings', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Redbark settings saved' }).waitFor();
  await page.getByRole('button', { name: 'Save Redbark settings', exact: true }).waitFor({ state: 'visible' });
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
  assert.equal(await page.getByLabel('OpenAI API key', { exact: true }).inputValue(), '');
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
  await page.getByLabel('Provider', { exact: true }).selectOption('bedrock');
  await page.getByLabel('AWS region', { exact: true }).selectOption('ap-southeast-2');
  await page.getByLabel('Model or inference profile ID / ARN', { exact: true }).fill('synthetic-bedrock-model');
  await page.getByLabel('AWS access key ID', { exact: true }).fill('synthetic-access-key');
  await page.getByLabel('AWS secret access key', { exact: true }).fill('synthetic-secret-key');
  await page.getByRole('button', { name: 'Save provider settings', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Settings updated.' }).waitFor();
  assert.equal(lastWrite('/api/settings/provider').region, 'ap-southeast-2');
  assert.equal(lastWrite('/api/settings/provider').enabled, false, 'provider switch requires re-enable');
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
    'Database Settings browser checks passed: Redbark write-only save/preserve/clear, signing-secret controls, failed-save retry, OpenAI first save, independent classification flags/limits, Bedrock switch, assistant OpenAI first save, webhook registration and responsive layout. All APIs mocked.'
  );
} finally {
  await browser.close();
}
