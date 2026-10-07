import { installBrowserStorageGuard } from './browser-storage-guard.mjs';
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const base = process.env.DOLPHINO_TEST_URL || 'http://localhost:3001';
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox']
});
await mkdir('artifacts', { recursive: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const assertPageStorageUnused = await installBrowserStorageGuard(page);
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
try {
  await page.goto(base);
  await page.getByText('Total income', { exact: true }).waitFor();
  await page.getByText('$6,650.00', { exact: true }).first().waitFor();
  assert.equal(await page.locator('body').evaluate((e) => e.scrollWidth <= innerWidth), true, 'desktop overflow');
  await page.screenshot({
    path: 'artifacts/dolphino-desktop.png',
    fullPage: true
  });
  await page.getByText('Total spending', { exact: true }).click();
  await page.getByRole('table').waitFor();
  assert(
    await page.getByText('Linen & Thread · Return', { exact: true }).count(),
    'refund appears in spending drilldown'
  );
  assert.equal(await page.getByText('Credit card repayment', { exact: true }).count(), 0, 'repayment excluded');
  await page.getByRole('button', { name: 'Transactions', exact: true }).click();
  const clear = page.getByRole('button', { name: /Clear drilldown/i });
  if (await clear.count()) {
    await clear.click();
  }

  await page.getByLabel('Search transactions').fill('Corner Coffee');
  await page.waitForTimeout(350);
  await page.getByText('Corner Coffee', { exact: true }).first().waitFor();
  assert.equal(
    await page.getByText('Corner Coffee', { exact: true }).count(),
    2,
    'genuine identical purchases preserved'
  );
  await page.getByRole('button', { name: 'Edit Corner Coffee', exact: true }).first().click();
  await page.getByRole('dialog').waitFor();
  await page.getByRole('button', { name: 'Add split', exact: true }).click();
  await page.getByLabel('Split 1 amount', { exact: true }).fill('-6.49');
  await page.getByRole('button', { name: 'Save correction', exact: true }).click();
  await page.getByText(/Split amounts must add up exactly/).waitFor();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await page.getByRole('dialog').count(), 0, 'cancel closes without save');
  await page.getByRole('button', { name: 'Accounts', exact: true }).click();
  await page.getByText('Everyday · Fictional Bank', { exact: true }).waitFor();
  assert(await page.getByText(/Not reconciled/).count());
  await page.getByRole('button', { name: 'Budgets', exact: true }).click();
  await page.getByRole('button', { name: 'Add budget', exact: true }).waitFor();
  await page.screenshot({
    path: 'artifacts/dolphino-budgets.png',
    fullPage: true
  });
  await page.getByRole('button', { name: 'Add budget', exact: true }).click();
  // Budgets take a category from the catalog; the demo has no Health budget.
  await page.getByLabel('Category', { exact: true }).selectOption({ label: 'Health' });
  await page.getByLabel('Monthly cap', { exact: true }).fill('42.50');
  await page.getByRole('button', { name: 'Save budget', exact: true }).click();
  await page.getByRole('heading', { name: 'Health', exact: true }).waitFor();
  const month = await page.locator('#month').inputValue();
  const budgets = await (await page.request.get(`${base}/api/budgets?month=${month}&currency=AUD`)).json();
  const created = budgets.budgets.find((b) => (b.categoryDisplayLabel || b.category) === 'Health');
  assert(created, 'the saved budget is listed for the month on screen');
  const removed = await page.request.delete(base + '/api/budgets/' + created.id, {
    headers: { Origin: base }
  });
  assert.equal(removed.status(), 200, 'the synthetic budget is removed again');

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('heading', { name: 'Redbark settings', exact: true }).waitFor();
  assert(await page.getByRole('button', { name: 'Test connection', exact: true }).isDisabled());
  const exported = await (await page.request.get(base + '/api/export?month=2026-09')).json();
  assert(exported.summary && exported.transactions.length > 0);
  await page.route('**/api/accounts', (r) =>
    r.fulfill({
      status: 503,
      contentType: 'application/json',
      body: '{"error":"Database temporarily unavailable"}'
    })
  );
  await page.getByRole('button', { name: 'Accounts', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Database temporarily unavailable' }).waitFor();
  await page.unroute('**/api/accounts');
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await page.getByText('Everyday · Fictional Bank', { exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Open menu', exact: true }).click();
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  await page.getByText('Total income', { exact: true }).waitFor();
  await page.getByText('$6,650.00', { exact: true }).first().waitFor();
  await page.waitForTimeout(400);
  assert.equal(await page.locator('body').evaluate((e) => e.scrollWidth <= innerWidth), true, 'mobile overflow');
  await page.screenshot({
    path: 'artifacts/dolphino-mobile.png',
    fullPage: true
  });
  assert.deepEqual(errors, []);
  await assertPageStorageUnused();
  console.log(
    'Browser checks passed: desktop/mobile, drilldowns, duplicate purchases, cancelled editor, budget save, accounts, settings, export and error recovery.'
  );
} finally {
  await browser.close();
}
