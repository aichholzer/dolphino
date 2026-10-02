import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { createServer } from 'vite';
import { installBrowserStorageGuard } from './browser-storage-guard.mjs';

// Fully synthetic, isolated browser checks. No existing session, credentials,
// database, external provider, or deployed application is contacted.
const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  configFile: fileURLToPath(new URL('../vite.config.mjs', import.meta.url)),
  server: { host: '127.0.0.1', port: 0, strictPort: true }
});
await server.listen();
const base = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
  args: ['--no-sandbox']
});
const revision = '1'.padStart(64, '0');
const session = {
  authenticated: true,
  demo: false,
  user: { id: 'navigation-admin', role: 'admin', name: 'Test admin' },
  currency: 'AUD',
  timeZone: 'UTC'
};
const shared = {
  provider: 'bedrock',
  region: 'ap-southeast-2',
  configured: true,
  encryptionAvailable: true,
  credentialsAvailable: true,
  settingsAvailable: true,
  discoveryRevision: revision,
  migration: { status: 'ready' },
  credentials: { accessKeyId: { configured: true }, secretAccessKey: { configured: true } },
  regionCatalog: { regions: [{ id: 'ap-southeast-2', label: 'Sydney' }] }
};
const features = {
  '/api/settings/provider': {
    model: 'synthetic.model',
    enabled: false,
    autoClassify: false,
    autoApply: false,
    dailyRequestLimit: 20,
    batchSize: 5
  },
  '/api/settings/assistant': {
    model: 'synthetic.model',
    enabled: false,
    dataSharingAcknowledged: false,
    dailyRequestsPerUser: 10,
    maxToolCalls: 4,
    maxRounds: 3,
    maxOutputTokens: 1024,
    tools: []
  }
};
const calls = [];
const errors = [];
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const noStorage = await installBrowserStorageGuard(page);
page.on('pageerror', (error) => errors.push(error.message));
await page.route('**/api/**', async (route) => {
  const request = route.request();
  const path = new URL(request.url()).pathname;
  calls.push({ path, method: request.method() });
  let json = {};
  if (path === '/api/session') {
    json = session;
  } else if (path === '/api/dashboard') {
    json = { incomeMinor: '0', expensesMinor: '0', netMinor: '0' };
  } else if (path === '/api/settings') {
    json = { redbark: {} };
  } else if (path === '/api/settings/ai') {
    json = shared;
  } else if (features[path]) {
    json = { ...shared, ...features[path] };
  } else if (path === '/api/settings/ai/models') {
    json = {
      revision: shared.discoveryRevision,
      region: shared.region,
      models: [
        {
          id: 'synthetic.model',
          name: 'Synthetic model',
          provider: 'Synthetic',
          kind: 'foundation',
          lifecycle: 'ACTIVE'
        }
      ]
    };
  } else if (path === '/api/settings/redbark') {
    json = {
      version: '2026-10-01.wattle',
      backfillDays: 90,
      credentials: {},
      encryptionAvailable: true,
      credentialsAvailable: true
    };
  } else if (path === '/api/settings/webhook') {
    json = { publicBaseUrl: '' };
  } else if (path === '/api/settings/simplefin') {
    json = {
      configured: false,
      backfillDays: 30,
      enabled: false,
      encryptionAvailable: true,
      credentialsAvailable: true,
      accounts: []
    };
  } else if (path === '/api/import-health') {
    json = { accounts: [], jobs: [] };
  } else if (path === '/api/users') {
    json = { users: [], invitations: [] };
  } else if (path === '/api/users/grant-options') {
    json = { accounts: [], budgets: [] };
  } else if (path === '/api/settings/notifications') {
    json = {
      smtp: { enabled: false, from: '', recipients: [] },
      telegram: { enabled: false },
      summaryFields: ['category', 'period', 'amount', 'remaining'],
      audienceConfirmed: false
    };
  } else if (path === '/api/notifications/deliveries') {
    json = [];
  }

  await route.fulfill({ json });
});
const nav = () => page.getByRole('navigation', { name: 'Settings sections' });
const sectionLink = (name) => nav().getByRole('link', { name: new RegExp(`^${name}`) });
try {
  await page.goto(`${base}/#settings/ai`);
  await expect(page.getByRole('heading', { name: 'Shared AI connection', exact: true })).toBeVisible();
  await expect(page.getByLabel('Available classification Bedrock models')).toBeEnabled();
  await expect(page.getByLabel('Available assistant Bedrock models')).toBeEnabled();
  assert.equal(
    calls.filter((call) => call.path.endsWith('/models')).length,
    1,
    'both pickers share one discovery read'
  );
  assert.equal(
    calls.some((call) =>
      ['/api/settings/redbark', '/api/settings/simplefin', '/api/users', '/api/settings/notifications'].includes(
        call.path
      )
    ),
    false,
    'inactive panels do not mount or fetch'
  );
  await expect(page.getByLabel('AWS access key ID', { exact: true })).toHaveCount(1);
  await expect(sectionLink('AI features')).toHaveAttribute('aria-current', 'page');
  await sectionLink('Data').click();
  await expect(page).toHaveURL(/#settings\/data$/);
  await expect(page.getByRole('heading', { name: 'Import health & history' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Shared AI connection' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /^Export / })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Shared AI connection' })).toBeVisible();
  await page.goForward();
  await expect(page.getByRole('heading', { name: 'Import health & history' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Import health & history' })).toBeVisible();
  await sectionLink('AI features').click();
  await expect(page.getByLabel('Available classification Bedrock models')).toBeEnabled();
  const key = page.getByLabel('AWS access key ID', { exact: true });
  await key.fill('synthetic-unsaved-draft');
  let dialogs = 0;
  const reject = async (dialog) => {
    dialogs++;
    await dialog.dismiss();
  };

  page.on('dialog', reject);
  await sectionLink('Members').click();
  await expect(page).toHaveURL(/#settings\/ai$/);
  await expect(key).toHaveValue('synthetic-unsaved-draft');
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  await expect(page).toHaveURL(/#settings\/ai$/);
  await expect(key).toHaveValue('synthetic-unsaved-draft');
  await page.goBack();
  await expect(page).toHaveURL(/#settings\/ai$/);
  await expect(key).toHaveValue('synthetic-unsaved-draft');
  assert.equal(dialogs, 3, 'cancelled submenu, workspace and browser Back preserve drafts without duplicate prompts');
  page.off('dialog', reject);
  page.once('dialog', (dialog) => dialog.accept());
  await sectionLink('Members').click();
  await expect(page.getByRole('heading', { name: 'Household accounts' })).toBeVisible();
  await page.getByLabel('Invitation email address').fill('synthetic@example.test');
  page.once('dialog', (dialog) => dialog.dismiss());
  await sectionLink('Notifications').click();
  await expect(page.getByLabel('Invitation email address')).toHaveValue('synthetic@example.test');
  page.once('dialog', (dialog) => dialog.accept());
  await sectionLink('Notifications').click();
  await expect(page.getByRole('heading', { name: 'Keep the household in the loop' })).toBeVisible();
  await page.getByLabel('SMTP connection URL').fill('synthetic-smtp-draft');
  page.once('dialog', (dialog) => dialog.dismiss());
  await sectionLink('Data').click();
  await expect(page.getByLabel('SMTP connection URL')).toHaveValue('synthetic-smtp-draft');
  await page.getByLabel('SMTP connection URL').fill('');
  await sectionLink('Data').click();
  await page.getByLabel('One-use setup token').fill('synthetic-token-draft');
  page.once('dialog', (dialog) => dialog.dismiss());
  await sectionLink('RedBark').click();
  await expect(page.getByLabel('One-use setup token')).toHaveValue('synthetic-token-draft');
  await page.getByLabel('One-use setup token').fill('');
  await sectionLink('RedBark').click();
  await expect(page.getByRole('heading', { name: 'Redbark settings' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Redbark thin-event notifications' })).toBeVisible();
  await page.getByLabel('Redbark API key', { exact: true }).fill('synthetic-redbark-draft');
  page.once('dialog', (dialog) => dialog.dismiss());
  await sectionLink('AI features').click();
  await expect(page.getByLabel('Redbark API key', { exact: true })).toHaveValue('synthetic-redbark-draft');
  await page.getByLabel('Redbark API key', { exact: true }).fill('');
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const name of ['RedBark', 'Members', 'Notifications', 'Data', 'AI features']) {
      await sectionLink(name).click();
      await expect(sectionLink(name)).toHaveAttribute('aria-current', 'page');
      assert.equal(
        await page.locator('body').evaluate((body) => body.scrollWidth <= innerWidth),
        true,
        `${name} fits ${width}px`
      );
    }
  }

  await noStorage();
  assert.deepEqual(errors, []);
  // Even an administrator URL cannot mount settings for a lower-privilege principal.
  session.user = { id: 'navigation-member', role: 'member', name: 'Test member' };
  session.permissions = { accounts: [{ accountId: 'allowed', access: 'view' }] };
  const start = calls.length;
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Your money, at a glance.' })).toBeVisible();
  await expect(nav()).toHaveCount(0);
  assert.equal(
    calls.slice(start).some((call) => call.path.startsWith('/api/settings')),
    false,
    'member deep link never fetches settings'
  );
  console.log(
    'Settings navigation passed: deep links, active-only mounts, shared discovery, Back/Forward/reload, dirty form cancellation, responsive layouts, no browser storage and member access boundaries. All APIs mocked.'
  );
} finally {
  await browser.close();
  await server.close();
}
