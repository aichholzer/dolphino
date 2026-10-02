import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { categoryFixture } from '../../backend/test/helpers/category-fixture.mjs';
import { installBrowserStorageGuard } from './browser-storage-guard.mjs';

const f = await categoryFixture();
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox']
});
const errors = [];
const unexpected = [];
const contexts = [];
await mkdir('artifacts', { recursive: true });
async function principal(role) {
  const context = await browser.newContext({ viewport: { width: 1360, height: 980 } });
  contexts.push(context);
  const [name, value] = f.cookies[role].split('=');
  await context.addCookies([{ name, value, url: f.url, httpOnly: true, sameSite: 'Strict' }]);
  await context.route('**/*', async (route) => {
    if (new URL(route.request().url()).origin !== f.url) {
      unexpected.push(route.request().url());
      await route.abort();
    } else {
      await route.continue();
    }
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', (response) => {
    if (response.status() >= 500) {
      errors.push(`${response.status()} ${response.url()}`);
    }
  });
  const noStorage = await installBrowserStorageGuard(page);
  return { page, noStorage };
}

async function transactions(page) {
  await page.getByRole('button', { name: 'Transactions', exact: true }).click();
  await page.getByLabel('All imported history').check();
  await expect(page.getByLabel('Filter category')).toBeVisible();
}

async function edit(page, description) {
  await page.getByRole('button', { name: `Edit ${description}`, exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Category', { exact: true })).toBeVisible();
  return dialog;
}

try {
  const before = await f.store.report({ month: '2026-09', currency: 'AUD' });
  const evidence = (await f.pool.query('SELECT * FROM provider_observations ORDER BY id')).rows;
  const { page, noStorage } = await principal('admin');
  await page.goto(f.url + '/#settings/categories');
  await expect(page.getByRole('heading', { name: 'Your categories', exact: true })).toBeVisible();
  await page.getByLabel('New category', { exact: true }).fill('Equipment & supplies');
  await page.getByRole('button', { name: 'Create category', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Rename Equipment & supplies', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Rename Equipment & supplies', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Rename Travel', exact: true }).click();
  await page.getByLabel('Category name', { exact: true }).fill('Journeys');
  await page.getByRole('button', { name: 'Save name', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Rename Journeys', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Review', exact: true }).click();
  const review = page.locator('.review-row').filter({ hasText: 'Train to conference' });
  await expect(review.getByRole('button', { name: 'Accept current classification', exact: true })).toBeVisible();
  await expect(review.getByRole('button', { name: 'Keep separate', exact: true })).toHaveCount(0);
  await review.getByRole('button', { name: 'Review details', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Category', { exact: true })).toHaveValue('Travel');
  await expect(dialog.getByLabel('Category', { exact: true }).locator('option:checked')).toHaveText('Journeys');
  await expect(
    dialog.getByLabel('Category', { exact: true }).locator('option', { hasText: 'Equipment & supplies' })
  ).toHaveCount(1);
  assert.ok(!(await dialog.getByLabel('Category', { exact: true }).innerText()).includes('cat_'));
  for (const tag of ['Work', 'conference', '<img src=x onerror=alert(1)>']) {
    await dialog.getByLabel('New tag', { exact: true }).fill(tag);
    await dialog.getByRole('button', { name: 'Add tag', exact: true }).click();
  }

  await dialog.getByRole('button', { name: 'Save correction', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  assert.equal((await f.store.getTransaction(f.tx.id)).reviewRequired, true, 'tags alone must not dismiss review');
  const transferReview = page.locator('.review-row').filter({ hasText: 'Confidential repayment' });
  await expect(transferReview).toContainText('excluded from income and spending totals');
  await transferReview.getByRole('button', { name: 'Accept current classification', exact: true }).click();
  assert.equal((await f.store.getTransaction(f.transfer.id)).kind, 'transfer');
  const pairReview = page.locator('.review-row').filter({ hasText: 'Posted hotel' });
  await expect(pairReview.getByRole('button', { name: 'Link pending', exact: true })).toBeVisible();
  await pairReview.getByRole('button', { name: 'Keep separate', exact: true }).click();
  await expect(pairReview).toHaveCount(0);
  assert.equal((await f.store.getTransaction(f.posted.id)).reviewRequired, false);
  assert.equal((await f.store.getTransaction(f.pending.id)).supersededBy, null);
  assert.equal((await f.store.getTransaction(f.pending.id)).status, 'pending');
  await transactions(page);
  await page.getByLabel('Filter tag', { exact: true }).selectOption('work');
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await page.getByLabel('Filter category', { exact: true }).selectOption('Travel');
  await page.getByLabel('Search transactions', { exact: true }).fill('Journeys');
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await expect(page.locator('tbody')).toContainText('<img src=x onerror=alert(1)>');
  await expect(page.locator('tbody img')).toHaveCount(0);
  const exportUrl = await page.getByRole('link', { name: 'Export', exact: true }).getAttribute('href');
  const exportResponse = await page.request.get(f.url + exportUrl);
  assert.equal((await exportResponse.json()).transactions.length, 1);
  await page.reload();
  await page.getByLabel('All imported history').check();
  dialog = await edit(page, 'Train to conference');
  await expect(dialog.getByRole('button', { name: 'Remove tag work', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Remove tag conference', exact: true }).click();
  await dialog.getByRole('button', { name: 'Save correction', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  dialog = await edit(page, 'Train to conference');
  await expect(dialog.getByRole('button', { name: 'Remove tag conference', exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Budgets', exact: true }).click();
  await page.getByLabel('Reporting month', { exact: true }).fill('2026-09');
  await expect(page.getByRole('heading', { name: 'Journeys', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Add budget', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Category', { exact: true }).selectOption('Equipment & supplies');
  await dialog.getByLabel('Monthly cap', { exact: true }).fill('99.95');
  await dialog.getByRole('button', { name: 'Save budget', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Equipment & supplies', exact: true })).toBeVisible();
  await page.goto(f.url + '/#settings/categories');
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.getByRole('button', { name: 'Delete Journeys', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Restore Journeys', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Restore Journeys', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Delete Journeys', exact: true })).toBeVisible();
  }

  await page.getByRole('button', { name: 'Delete Journeys', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Restore Journeys', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Restore Journeys', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() => page.locator('.sidebar').evaluate((element) => element.getBoundingClientRect().right))
    .toBeLessThanOrEqual(0);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.getByRole('button', { name: 'Restore Journeys', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Delete Journeys', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Delete Journeys', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Restore Journeys', exact: true })).toBeVisible();
  await page.screenshot({ path: 'artifacts/categories-settings-mobile.png', fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 1360, height: 980 });
  await page.getByRole('button', { name: 'Budgets', exact: true }).click();
  await page.getByRole('button', { name: 'Add budget', exact: true }).click();
  dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Category', { exact: true }).locator('option[value="Travel"]')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await transactions(page);
  await page.getByLabel('Filter category', { exact: true }).selectOption('Travel');
  await expect(page.locator('tbody')).toContainText('Train to conference');
  dialog = await edit(page, 'Train to conference');
  await expect(dialog.getByLabel('Category', { exact: true }).locator('option:checked')).toHaveText(
    'Journeys (archived)'
  );
  await dialog.getByRole('button', { name: 'Save correction', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.screenshot({ path: 'artifacts/categories-transactions-desktop.png', fullPage: true });
  const after = await f.store.report({ month: '2026-09', currency: 'AUD' });
  for (const key of ['expensesMinor', 'incomeMinor', 'netMinor', 'transfersMinor']) {
    assert.equal(after[key], before[key]);
  }

  assert.deepEqual((await f.pool.query('SELECT * FROM provider_observations ORDER BY id')).rows, evidence);
  await noStorage();
  console.log(
    'PASS compiled admin: create/rename/archive/restore, review dropdown, multiple tags, escaping, reload, repeated saves, budget dropdown, mobile layout, stable totals/evidence'
  );

  for (const role of ['editor', 'viewer']) {
    const member = await principal(role);
    const page = member.page;
    await page.goto(f.url);
    await expect(page.getByRole('button', { name: 'Settings', exact: true })).toHaveCount(0);
    await transactions(page);
    assert.ok(!(await page.getByLabel('Filter category').innerText()).includes('Secret'));
    assert.ok(!(await page.getByLabel('Filter tag').innerText()).includes('secret-tag'));
    assert.ok(!(await page.getByLabel('Filter tag').innerText()).includes('private-transfer-tag'));
    await page.getByLabel('Search transactions').fill('Hidden merchant');
    await expect(page.locator('tbody tr')).toHaveCount(0);
    await page.getByLabel('Search transactions').fill('');
    await expect(page.locator('tbody')).toContainText('Train to conference');
    if (role === 'viewer') {
      await expect(page.getByRole('button', { name: 'Edit Train to conference', exact: true })).toHaveCount(0);
    } else {
      dialog = await edit(page, 'Train to conference');
      await dialog.getByLabel('New tag').fill('member-label');
      await dialog.getByRole('button', { name: 'Add tag', exact: true }).click();
      await dialog.getByRole('button', { name: 'Save correction', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await page.reload();
      await page.getByLabel('All imported history').check();
      await page.getByLabel('Filter tag').selectOption('member-label');
      await expect(page.locator('tbody tr')).toHaveCount(1);
    }

    await member.noStorage();
  }

  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  console.log(
    'PASS compiled members: editor persistence, viewer restrictions, private category/tag/search isolation; no browser persistent storage or external requests'
  );
} finally {
  for (const context of contexts) {
    await context.close();
  }

  await browser.close();
  await f.close();
}
