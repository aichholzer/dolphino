import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { createCompiledServer } from './compiled-server.mjs';
import { installBrowserStorageGuard } from './browser-storage-guard.mjs';

// Fully synthetic, isolated browser checks. No existing session, credentials,
// database, external provider, or deployed application is contacted.
const server = await createCompiledServer({ root: fileURLToPath(new URL('..', import.meta.url)) });
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
    tools: []
  }
};
const calls = [];
const errors = [];
const external = [];
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
const noStorage = await installBrowserStorageGuard(page);
page.on('pageerror', (error) => errors.push(error.message));
await page.route('**/*', async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  const path = url.pathname;
  if (url.origin !== base) {
    external.push(url.href);
    await route.abort();
    return;
  }

  if (!path.startsWith('/api/')) {
    await route.continue();
    return;
  }

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
  } else if (['/api/settings/simplefin', '/api/settings/pocketsmith'].includes(path)) {
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
  } else if (path === '/api/settings/deleted-accounts') {
    json = { accounts: [] };
  } else if (path === '/api/categories' || path === '/api/settings/categories') {
    json = { catalog: [] };
  } else if (path === '/api/tags') {
    json = { tags: [] };
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
  await sectionLink('Bank feeds').click();
  const simplefinSummary = page.locator('.bank-feed-panel > summary').filter({ hasText: 'SimpleFIN' });
  await simplefinSummary.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'SimpleFIN optional import' })).toBeVisible();
  await page.getByLabel('One-use setup token').fill('synthetic-token-draft');
  await simplefinSummary.click();
  await expect(page.getByLabel('One-use setup token')).toBeHidden();
  await simplefinSummary.focus();
  await page.keyboard.press('Space');
  await expect(page.getByLabel('One-use setup token')).toHaveValue('synthetic-token-draft');
  page.once('dialog', (dialog) => dialog.dismiss());
  await sectionLink('Data').click();
  await expect(page.getByLabel('One-use setup token')).toHaveValue('synthetic-token-draft');
  await page.getByLabel('One-use setup token').fill('');
  await simplefinSummary.click();
  const pocketSummary = page.locator('.bank-feed-panel > summary').filter({ hasText: 'PocketSmith' });
  await pocketSummary.focus();
  await page.keyboard.press('Enter');
  const pocketKey = page.getByLabel('Developer key', { exact: true });
  await pocketKey.fill('synthetic-pocket-draft');
  await pocketSummary.click();
  page.once('dialog', (dialog) => dialog.dismiss());
  await sectionLink('Data').click();
  await expect(page).toHaveURL(/#settings\/bank-feeds$/);
  await pocketSummary.click();
  await expect(pocketKey).toHaveValue('synthetic-pocket-draft');
  await pocketKey.fill('');
  await pocketSummary.click();
  await expect(page.getByRole('heading', { name: 'Redbark settings' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Redbark thin-event notifications' })).toBeVisible();
  await page.getByLabel('Redbark API key', { exact: true }).fill('synthetic-redbark-draft');
  page.once('dialog', (dialog) => dialog.dismiss());
  await sectionLink('AI features').click();
  await expect(page.getByLabel('Redbark API key', { exact: true })).toHaveValue('synthetic-redbark-draft');
  await page.getByLabel('Redbark API key', { exact: true }).fill('');
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const name of ['Bank feeds', 'Categories', 'Members', 'Notifications', 'Data', 'AI features']) {
      await sectionLink(name).click();
      await expect(sectionLink(name)).toHaveAttribute('aria-current', 'page');
      assert.equal(
        await page.locator('body').evaluate((body) => body.scrollWidth <= innerWidth),
        true,
        `${name} fits ${width}px`
      );
      if (name === 'Bank feeds' || name === 'Notifications') {
        await page.screenshot({
          path: `/tmp/dolphino-settings-${name.toLowerCase().replaceAll(' ', '-')}-${width}.png`,
          fullPage: true
        });
      }
    }
  }

  await noStorage();
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  // Even an administrator URL cannot mount settings for a lower-privilege principal.
  session.user = { id: 'navigation-member', role: 'member', name: 'Test member' };
  session.permissions = { accounts: [{ accountId: 'allowed', access: 'view' }] };
  // Let the administrator's AI section finish its reads, then count only requests from the reloaded document.
  await expect(page.getByLabel('Available classification Bedrock models')).toBeEnabled();
  await expect(page.getByLabel('Available assistant Bedrock models')).toBeEnabled();
  let start = calls.length;
  const committed = page.waitForEvent('framenavigated', (frame) => {
    start = calls.length;
    return frame === page.mainFrame();
  });
  await page.reload();
  await committed;
  await expect(page.getByRole('heading', { name: 'Your money, at a glance.' })).toBeVisible();
  await expect(nav()).toHaveCount(0);
  const settingsReads = calls.slice(start).filter((call) => call.path.startsWith('/api/settings'));
  assert.deepEqual(settingsReads, [], 'member deep link never fetches settings');
  console.log(
    'Compiled Settings navigation passed: Bank feeds grouping, keyboard accordion controls, preserved provider drafts, deep links, active-only mounts, Back/Forward/reload, dirty form cancellation, 1440/390/320px layouts, no browser storage/external requests and member access boundaries. All APIs mocked.'
  );
} finally {
  await browser.close();
  await server.close();
}
