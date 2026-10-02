import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { categoryFixture } from '../../backend/test/helpers/category-fixture.mjs';
import { installBrowserStorageGuard } from './browser-storage-guard.mjs';
const f = await categoryFixture();
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox']
});
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
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

    // Only disconnected integration status panels are fixtures. Every financial API is real HTTP/PostgreSQL.
    if (url.pathname === '/api/settings/simplefin') {
      await route.fulfill({
        json: {
          enabled: false,
          configured: false,
          backfillDays: 30,
          accounts: [],
          jobs: [],
          providerErrors: [],
          credentialsAvailable: false
        }
      });
      return;
    }

    if (url.pathname === '/api/import-health') {
      await route.fulfill({ json: { accounts: [], jobs: [], categories: {}, redbark: {} } });
      return;
    }

    await route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('response', (r) => {
    if (r.status() >= 500) {
      errors.push(`${r.status()} ${r.url()}`);
    }
  });
  const noStorage = await installBrowserStorageGuard(page);
  await page.goto(f.url + '/#accounts');
  await expect(page.getByRole('button', { name: 'Add manual account', exact: true })).toBeVisible();
  const dialog = page.getByRole('dialog');
  for (const [label, amount] of [
    ['Cash wallet', '100.00'],
    ['Savings jar', '20.00']
  ]) {
    await page.getByRole('button', { name: 'Add manual account', exact: true }).click();
    await dialog.getByLabel('Account name').fill(label);
    await dialog.getByLabel('Opening date').fill('2026-09-01');
    await dialog.getByLabel('Opening balance').fill(amount);
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('heading', { name: label, exact: true })).toBeVisible();
  }

  let wallet = page
    .locator('.account-card')
    .filter({ has: page.getByRole('heading', { name: 'Cash wallet', exact: true }) });
  await wallet.getByRole('button', { name: 'Add entry', exact: true }).click();
  await dialog.getByLabel('Date', { exact: true }).fill('2026-09-12');
  await dialog.getByLabel('Amount (negative for expenses)').fill('-12.50');
  await dialog.getByLabel('Description', { exact: true }).fill('Conference taxi');
  await dialog.getByLabel('Category', { exact: true }).selectOption('Travel');
  const tagInput = dialog.getByLabel('New tag', { exact: true });
  await tagInput.fill('work');
  await tagInput.press('Enter');
  await tagInput.fill('conference');
  await tagInput.press('Enter');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(wallet.locator('.account-balance')).toHaveText('$87.50');
  await wallet.getByRole('button', { name: 'Transfer', exact: true }).click();
  await dialog.getByLabel('Date', { exact: true }).fill('2026-09-13');
  await dialog.getByLabel('Amount sent').fill('10.00');
  await dialog.getByLabel('To manual account').selectOption({ label: 'Savings jar · AUD' });
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(wallet.locator('.account-balance')).toHaveText('$77.50');
  await wallet.getByRole('button', { name: 'Adjust balance', exact: true }).click();
  await dialog.getByLabel('Date', { exact: true }).fill('2026-09-14');
  await dialog.getByLabel('Target balance at this date').fill('80.00');
  await dialog.getByLabel('Reason').fill('Counted cash');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(wallet.locator('.account-balance')).toHaveText('$80.00');
  await wallet.getByRole('button', { name: 'View transactions for Cash wallet' }).click();
  await page.getByRole('button', { name: 'Edit Conference taxi', exact: true }).click();
  await dialog.getByLabel('Amount (negative for expenses)').fill('-15.00');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole('button', { name: 'Edit Conference taxi', exact: true }).click();
  await dialog.getByRole('button', { name: 'Void entry', exact: true }).click();
  await dialog.getByLabel('Reason').fill('Duplicate');
  await dialog.getByRole('button', { name: 'Confirm void', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: 'Edit Conference taxi', exact: true })).toHaveCount(0);
  await page.getByLabel('Show voided entries').check();
  await page.getByRole('button', { name: 'View history for Conference taxi', exact: true }).click();
  await expect(dialog.getByText('This entry is read-only:', { exact: false })).toBeVisible();
  await dialog.locator('summary').click();
  await expect(dialog).toContainText('entry voided');
  await dialog.getByRole('button', { name: 'Close', exact: true }).last().click();
  await page.locator('#workspace-navigation').getByRole('button', { name: 'Accounts', exact: true }).click();
  await wallet.getByRole('button', { name: 'Freeze', exact: true }).click();
  await dialog.getByLabel('Reason').fill('Temporarily excluded');
  await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(wallet).toContainText('Frozen');
  await expect(wallet.getByRole('button', { name: 'Add entry', exact: true })).toHaveCount(0);
  await wallet.getByRole('button', { name: 'Delete account', exact: true }).click();
  await expect(dialog).toContainText('budget spending');
  await dialog.getByLabel('Reason').fill('Hide wallet');
  await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(wallet).toHaveCount(0);
  await page.goto(f.url + '/#settings/data');
  await page.getByRole('button', { name: 'Restore Cash wallet', exact: true }).click();
  await expect(page.getByText('Account and historical totals restored.')).toBeVisible();
  await expect(
    page.locator('.settings-card').filter({ has: page.getByRole('heading', { name: 'Deleted accounts', exact: true }) })
  ).toHaveAttribute('aria-busy', 'false');
  await page.goto(f.url + '/#accounts');
  await expect(wallet).toContainText('Frozen');
  await wallet.getByRole('button', { name: 'Unfreeze', exact: true }).click();
  await dialog.getByLabel('Reason').fill('Use again');
  await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(wallet.getByRole('button', { name: 'Add entry', exact: true })).toBeVisible();
  // Unsaved values stay in memory and navigation is guarded.
  await wallet.getByRole('button', { name: 'Add entry', exact: true }).click();
  await dialog.getByLabel('Description', { exact: true }).fill('Unsaved draft');
  page.once('dialog', (d) => d.dismiss());
  await dialog.getByRole('button', { name: 'Close', exact: true }).last().click();
  await expect(dialog).toBeVisible();
  page.once('dialog', (d) => d.accept());
  await dialog.getByRole('button', { name: 'Close', exact: true }).last().click();
  await expect(dialog).toBeHidden();

  await page.getByRole('button', { name: 'Add manual account', exact: true }).click();
  await dialog.getByLabel('Account name').fill('Temporary envelope');
  await dialog.getByLabel('Opening date').fill('2026-09-01');
  await dialog.getByLabel('Opening balance').fill('0');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toBeHidden();
  const spare = page
    .locator('.account-card')
    .filter({ has: page.getByRole('heading', { name: 'Temporary envelope', exact: true }) });
  await spare.getByRole('button', { name: 'Delete account', exact: true }).click();
  await dialog.getByLabel('Reason').fill('Remove test envelope');
  await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(dialog).toBeHidden();
  await page.goto(f.url + '/#settings/data');
  await page.getByLabel('Temporary envelope · manual', { exact: true }).check();
  await page.getByRole('button', { name: 'Preview permanent deletion', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Permanent local deletion', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Permanently delete selected accounts', exact: true })).toBeDisabled();
  await page.getByLabel('Type DELETE 1 ACCOUNT PERMANENTLY', { exact: true }).fill('DELETE 1 ACCOUNT PERMANENTLY');
  await page.getByRole('button', { name: 'Permanently delete selected accounts', exact: true }).click();
  await expect(
    page.getByText('Selected local accounts permanently deleted. External accounts were not changed.')
  ).toBeVisible();
  assert.equal((await f.pool.query("SELECT * FROM accounts WHERE name='Temporary envelope'")).rowCount, 0);
  await expect(
    page.locator('.settings-card').filter({ has: page.getByRole('heading', { name: 'Deleted accounts', exact: true }) })
  ).toHaveAttribute('aria-busy', 'false');
  await page.goto(f.url + '/#accounts');
  for (const width of [1440, 900, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      `No overflow at ${width}`
    );
  }

  const cash = (await f.json('admin', '/api/accounts')).accounts.find((a) => a.name === 'Cash wallet');
  await f.grant('viewer', { accounts: [{ accountId: cash.id, access: 'view' }] });
  await context.clearCookies();
  const [viewerName, viewerValue] = f.cookies.viewer.split('=');
  await context.addCookies([{ name: viewerName, value: viewerValue, url: f.url, httpOnly: true, sameSite: 'Strict' }]);
  await page.reload();
  await page.goto(f.url + '/#accounts');
  await expect(page.getByRole('heading', { name: 'Cash wallet', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add manual account', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add entry', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Freeze', exact: true })).toHaveCount(0);
  await noStorage();
  assert.ok([...assets].some((a) => a.endsWith('.js')));
  assert.deepEqual(external, []);
  assert.deepEqual(errors, []);
  console.log(
    'PASS compiled manual accounts browser: create, tagged expense, transfer, adjustment, edit, void/audit, freeze, delete/restore, draft guard, responsive, no persistent storage, no external calls'
  );
} finally {
  await context.close();
  await browser.close();
  await f.close();
}
