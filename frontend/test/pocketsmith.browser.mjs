import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { pocketSmithFixture, testPocketSmithKey } from '../../backend/test/helpers/pocketsmith-fixture.mjs';
import { installBrowserStorageGuard } from './browser-storage-guard.mjs';

const f = await pocketSmithFixture();
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox']
});
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
const errors = [],
  external = [],
  assets = new Set();
try {
  const [name, value] = f.cookies.admin.split('=');
  await context.addCookies([{ name, value, url: f.url, httpOnly: true, sameSite: 'Strict' }]);
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== f.url || /^\/(src|@vite|@id|node_modules)\//.test(url.pathname)) {
      external.push(url.href);
      await route.abort();
      return;
    }

    if (url.pathname.startsWith('/assets/')) {
      assets.add(url.pathname);
    }

    await route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', (response) => {
    if (response.status() >= 500) {
      errors.push(`${response.status()} ${response.url()}`);
    }
  });
  const noStorage = await installBrowserStorageGuard(page);
  await page.goto(f.url + '/#settings/data');
  const panel = page.locator('section[aria-labelledby="pocketsmith-heading"]');
  await expect(panel.getByRole('heading', { name: 'PocketSmith personal import' })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Test and discover accounts' })).toBeDisabled();
  const key = panel.getByLabel('Developer key', { exact: true });
  await expect(key).toHaveAttribute('type', 'password');
  await key.fill(testPocketSmithKey);
  await panel.getByRole('button', { name: 'Save PocketSmith settings' }).click();
  await expect(key).toHaveValue('');
  await expect(key).toHaveAttribute('placeholder', 'Saved key — leave blank to keep');
  f.setHook(async () => ({ status: 401, body: `Provider echo: ${testPocketSmithKey}` }));
  await panel.getByRole('button', { name: 'Test and discover accounts' }).click();
  await expect(panel.getByRole('alert')).toHaveText(
    'PocketSmith refused access. Check your saved developer key and test again.'
  );
  assert.deepEqual(errors.splice(0), [`502 ${f.url}/api/settings/pocketsmith/test`]);
  assert.equal((await f.state()).verified, false);
  f.setHook(null);
  await panel.getByRole('button', { name: 'Test and discover accounts' }).click();
  await expect(panel.getByRole('heading', { name: 'Ocean checking' })).toBeVisible();
  await expect(panel).toContainText('Native account 9001');
  await expect(panel).toContainText('Grouped accounts (700)');
  await panel.getByRole('button', { name: 'Import Ocean checking', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Pause Ocean checking', exact: true })).toBeVisible();
  await panel.getByLabel('Enable PocketSmith imports').check();
  await panel.getByRole('button', { name: 'Save PocketSmith settings' }).click();
  await expect(panel.getByRole('status')).toContainText('settings saved');
  await f.finishBackfill();
  await page.reload();
  await expect(panel).toContainText('Last successful import:');
  await panel.getByLabel('History from — Ocean checking').fill('2026-09-01');
  const queue = panel.getByRole('button', { name: 'Queue history for Ocean checking' });
  await expect(queue).toBeDisabled();
  await panel.getByLabel('History to — Ocean checking').fill('2026-09-30');
  await queue.click();
  await expect(panel).toContainText('History queued: 2026-09-01 through 2026-09-30');
  await page.locator('#workspace-navigation').getByRole('button', { name: 'Accounts', exact: true }).click();
  const account = page
    .locator('.account-card')
    .filter({ has: page.getByRole('heading', { name: 'Ocean checking', exact: true }) });
  await expect(account.locator('.account-balance')).toHaveText('$1,234.56');
  await expect(account).toContainText('Provider balance date 2026-10-02');
  await account.getByRole('button', { name: 'View transactions for Ocean checking' }).click();
  await expect(page.getByRole('button', { name: 'Edit Synthetic train', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Edit Synthetic train', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('conference');
  await expect(dialog).toContainText('work');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.goto(f.url + '/#settings/data');
  await panel.getByRole('button', { name: 'Disconnect locally' }).click();
  await expect(panel).toContainText('Not connected');
  assert.equal((await f.store.listTransactions()).filter((row) => row.accountId.startsWith('ps_')).length, 1);
  assert.ok(!(await page.content().then((html) => html.includes(testPocketSmithKey))));
  await noStorage();
  assert.ok(assets.size > 0);
  assert.deepEqual(external, []);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: '/tmp/dolphino-pocketsmith-settings.png', fullPage: true });
  console.log(
    'PocketSmith compiled-browser flow passed: encrypted settings, discovery, selection, import, history dates, balance semantics, tags, disconnect retention; real HTTP/PostgreSQL; no browser storage or external requests.'
  );
} finally {
  await context.close();
  await browser.close();
  await f.close();
}
