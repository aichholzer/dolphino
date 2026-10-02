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
const contexts = [];
const errors = [];
const unexpected = [];
const assets = new Set();
async function principal(role) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  contexts.push(context);
  const [name, value] = f.cookies[role].split('=');
  await context.addCookies([{ name, value, url: f.url, httpOnly: true, sameSite: 'Strict' }]);
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== f.url || /^\/(src|@vite|@id|node_modules)\//.test(url.pathname)) {
      unexpected.push(url.href);
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
  return { page, noStorage: await installBrowserStorageGuard(page) };
}

async function search(page, value) {
  await page.getByLabel('Search all transactions', { exact: true }).fill(value);
  await page.getByRole('button', { name: 'Run global search', exact: true }).click();
  await expect(page.getByLabel('Search transactions', { exact: true })).toHaveValue(value.trim());
  await expect(page.getByLabel('All imported history')).toBeChecked();
}

const rulesCount = async () => (await f.store.listRules()).length;
try {
  await f.store.correctTransaction(f.tx.id, { tags: ['work', 'manual'] });
  await f.json('admin', '/api/settings/categories', 'PATCH', { category: 'Travel', name: 'Journeys' });
  const evidence = (await f.pool.query('SELECT * FROM provider_observations ORDER BY id')).rows;
  const totals = await f.store.report({ month: '2026-09', currency: 'AUD' });
  const admin = await principal('admin');
  const { page } = admin;
  await page.goto(f.url + '/#review');
  await expect(page.getByLabel('Search all transactions')).toBeVisible();
  // Both entry points open the same safe editor, with literal source values.
  for (let repeat = 0; repeat < 2; repeat++) {
    await page.getByRole('button', { name: 'Create rule from Train to conference', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByLabel('Description contains')).toHaveValue('Train to conference');
    await expect(dialog.getByLabel('Assign category')).toHaveValue('Travel');
    await expect(dialog.getByLabel('Assign category').locator('option:checked')).toHaveText('Journeys');
    await expect(dialog.getByRole('button', { name: 'Remove tag work', exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Create rule', exact: true })).toBeDisabled();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(await rulesCount(), 0);
  }

  await search(page, 'Train');
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await page.getByRole('button', { name: 'Create rule from Train to conference', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel('New tag').fill('conference');
  await dialog.getByRole('button', { name: 'Add tag', exact: true }).click();
  await dialog.getByRole('button', { name: 'Preview matches', exact: true }).click();
  await expect(dialog.getByLabel('Rule preview')).toContainText('1 imported transaction');
  await expect(dialog.getByLabel('Rule preview')).toContainText('Tags to add: conference');
  assert.equal(await rulesCount(), 0, 'preview cannot create a rule');
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/rule-preview-desktop.png', fullPage: true });
  await dialog.getByLabel('Description contains').fill('Train to conference!');
  await expect(dialog.getByRole('button', { name: 'Create rule', exact: true })).toBeDisabled();
  await dialog.getByLabel('Description contains').fill('Train to conference');
  await dialog.getByRole('button', { name: 'Preview matches', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Create rule', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Create rule', exact: true }).evaluate((button) => {
    button.click();
    button.click();
  });
  await expect(dialog).toHaveCount(0);
  assert.equal(await rulesCount(), 1);
  assert.equal((await f.pool.query("SELECT * FROM audit_history WHERE action='rule-saved'")).rowCount, 1);
  assert.deepEqual((await f.store.getTransaction(f.tx.id)).tags, ['conference', 'manual', 'work']);
  await page.getByRole('button', { name: 'Rules', exact: true }).click();
  await page.getByRole('button', { name: 'Edit rule Train to conference', exact: true }).click();
  dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Assign category').locator('option:checked')).toHaveText('Journeys');
  await dialog.getByRole('button', { name: 'Remove tag manual', exact: true }).click();
  await dialog.getByRole('button', { name: 'Preview matches', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Save rule', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Save rule', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  assert.deepEqual((await f.store.getTransaction(f.tx.id)).tags, ['conference', 'manual', 'work']);
  // Back navigation prompts for changed drafts, cancellation retains the editor.
  await page.getByRole('button', { name: 'Add rule', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Description contains').fill('Unsaved literal');
  let prompt = page.waitForEvent('dialog');
  await page.evaluate(() => history.back());
  await (await prompt).dismiss();
  await expect(page).toHaveURL(/#rules$/);
  await expect(dialog.getByLabel('Description contains')).toHaveValue('Unsaved literal');
  prompt = page.waitForEvent('dialog');
  await page.evaluate(() => history.back());
  await (await prompt).accept();
  await expect(page.getByLabel('Search transactions')).toHaveValue('Train');
  await expect(dialog).toHaveCount(0);
  assert.equal(await rulesCount(), 1);
  // Explicit tag removal remains suppressed through editor save/reclassification.
  await page.getByRole('button', { name: 'Edit Train to conference', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Remove tag work', exact: true }).click();
  await dialog.getByRole('button', { name: 'Save correction', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: 'Rules', exact: true }).click();
  await page.getByRole('button', { name: 'Edit rule Train to conference', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Preview matches', exact: true }).click();
  await expect(dialog.getByLabel('Rule preview')).toContainText('Previously removed: work');
  await dialog.getByRole('button', { name: 'Save rule', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  assert.ok(!(await f.store.getTransaction(f.tx.id)).tags.includes('work'));
  // All global entry points search every accessible imported record and clear old scopes.
  for (const destination of ['Overview', 'Accounts', 'Budgets', 'Review', 'Rules', 'Settings']) {
    console.log('Checking global search from', destination);
    await page.getByRole('button', { name: destination, exact: true }).click();
    await search(page, 'Train');
    await expect(page.locator('tbody tr')).toHaveCount(1);
  }

  for (const draft of [
    { page: 'Accounts', action: 'Edit account Everyday', field: 'Account label', value: 'Unsaved account' },
    { page: 'Budgets', action: 'Add budget', field: 'Monthly cap', value: '123.45' },
    { page: 'Transactions', action: 'Edit Train to conference', field: 'New tag', value: 'unadded-draft' }
  ]) {
    if (draft.page === 'Transactions') {
      await search(page, 'Train');
    } else {
      await page.getByRole('button', { name: draft.page, exact: true }).click();
    }

    await page.getByRole('button', { name: draft.action, exact: true }).first().click();
    const editor = page.getByRole('dialog');
    await editor.getByLabel(draft.field, { exact: true }).fill(draft.value);
    const currentUrl = page.url();
    const rejected = page.waitForEvent('dialog').then((confirm) => confirm.dismiss());
    await page.evaluate(() => history.back());
    await rejected;
    await expect(page).toHaveURL(currentUrl);
    await expect(editor.getByLabel(draft.field, { exact: true })).toHaveValue(draft.value);
    await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
  }

  await page.goto(
    f.url +
      '/#transactions?currency=AUD&month=2000-01&accountId=hidden&category=Other&tag=secret-tag&status=pending&kind=income&page=99&from=2000-01-01&to=2000-01-02&ids=' +
      f.secret.id
  );
  await expect(page.getByLabel('Search all transactions')).toBeEnabled();
  await search(page, 'Journeys');
  const criteria = new URLSearchParams(new URL(page.url()).hash.split('?')[1]);
  assert.deepEqual([...criteria.keys()].sort(), ['allHistory', 'currency', 'search']);
  await expect(page.locator('tbody')).toContainText('Train to conference');
  await page.getByLabel('Filter tag').selectOption('conference');
  await page.getByLabel('Filter category').selectOption('Travel');
  await expect(page.locator('tbody tr')).toHaveCount(1);
  const savedUrl = page.url();
  await page.reload();
  await expect(page.getByLabel('Filter tag')).toHaveValue('conference');
  await expect(page.getByLabel('Filter category')).toHaveValue('Travel');
  await expect(page.getByLabel('Search all transactions')).toHaveValue('Journeys');
  await expect(page.locator('tbody tr')).toHaveCount(1);
  assert.equal(page.url(), savedUrl);
  await search(page, 'Split');
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await page.goBack();
  await expect(page.getByLabel('Search all transactions')).toHaveValue('Journeys');
  await expect(page.getByLabel('Filter tag')).toHaveValue('conference');
  await page.goForward();
  await expect(page.getByLabel('Search all transactions')).toHaveValue('Split');
  await page.getByRole('button', { name: 'Clear global search', exact: true }).click();
  await expect(page.getByLabel('Search transactions')).toHaveValue('');
  await expect(page.getByLabel('Filter tag')).toHaveValue('');
  await expect(page.getByLabel('All imported history')).toBeChecked();
  await expect(page.locator('tbody tr')).toHaveCount(7);
  // Global search honors an unsaved Settings draft without changing URL or data.
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByLabel('Redbark API key', { exact: true })).toBeVisible();
  await page.getByLabel('Redbark API key', { exact: true }).fill('synthetic-unsaved-only');
  await page.getByLabel('Search all transactions').fill('Train');
  prompt = page.waitForEvent('dialog').then((dialog) => dialog.dismiss());
  await page.getByRole('button', { name: 'Run global search', exact: true }).click();
  await prompt;
  await expect(page).toHaveURL(/#settings\/redbark$/);
  await expect(page.getByLabel('Redbark API key', { exact: true })).toHaveValue('synthetic-unsaved-only');
  prompt = page.waitForEvent('dialog').then((dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Run global search', exact: true }).click();
  await prompt;
  await expect(page.getByLabel('Search transactions')).toHaveValue('Train');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByLabel('Search all transactions')).toBeVisible();
  await search(page, 'conference');
  await expect(page.locator('tbody tr')).toHaveCount(1);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/rules-global-search-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'Create rule from Train to conference', exact: true }).click();
  await expect(page.getByRole('dialog').getByLabel('Assign category')).toBeVisible();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await admin.noStorage();
  console.log(
    'PASS compiled admin + PostgreSQL: shared category dropdown, Review/Transactions rule entry points, literal prefill/cancel, preview gating, tag application/suppression, history/draft guards, global scope reset, URL reload/back/forward/clear and mobile'
  );
  for (const role of ['editor', 'viewer', 'budget']) {
    const member = await principal(role);
    await member.page.goto(f.url);
    if (role === 'budget') {
      await expect(member.page.getByLabel('Search all transactions')).toBeDisabled();
    } else {
      await search(member.page, 'secret-tag');
      await expect(member.page.locator('tbody tr')).toHaveCount(0);
      await search(member.page, 'Train');
      await expect(member.page.locator('tbody tr')).toHaveCount(1);
      await expect(member.page.getByRole('button', { name: /^Create rule from / })).toHaveCount(0);
      await expect(member.page.getByRole('button', { name: 'Rules', exact: true })).toHaveCount(0);
      if (role === 'editor') {
        await member.page.getByRole('button', { name: 'Review', exact: true }).click();
      }

      await expect(member.page.getByRole('button', { name: /^Create rule from / })).toHaveCount(0);
      const response = await member.page.request.post(f.url + '/api/rules/preview', {
        data: { match: 'Hidden', category: 'Travel' },
        headers: { Origin: f.url }
      });
      assert.equal(response.status(), 403);
      await f.grant(role, {});
      await member.page.reload();
      await expect(member.page.getByLabel('Search all transactions')).toHaveCount(0);
      await expect(member.page.locator('body')).not.toContainText('Train to conference');
    }

    await member.noStorage();
  }

  const after = await f.store.report({ month: '2026-09', currency: 'AUD' });
  for (const key of ['expensesMinor', 'incomeMinor', 'netMinor', 'transfersMinor']) {
    assert.equal(after[key], totals[key]);
  }

  assert.deepEqual((await f.pool.query('SELECT * FROM provider_observations ORDER BY id')).rows, evidence);
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  assert.ok(assets.size >= 2);
  console.log(
    'PASS compiled access controls: editor/viewer forbidden rules and private search; budget-only disabled search; revoked access; stable totals/evidence; no persistent browser storage, development source serving, or external integrations'
  );
} finally {
  for (const context of contexts) {
    await context.close();
  }

  await browser.close();
  await f.close();
}
