import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { assistantSpendingFixture, spendingQuestion } from '../../backend/test/helpers/assistant-spending-fixture.mjs';
import { installBrowserStorageGuard } from './browser-storage-guard.mjs';

const f = await assistantSpendingFixture('bedrock');
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
  args: ['--no-sandbox']
});
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
const errors = [],
  external = [],
  assets = new Set();
try {
  const [name, value] = f.cookies.viewer.split('=');
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
  const noStorage = await installBrowserStorageGuard(page);
  await page.goto(f.url);
  await page.getByRole('button', { name: 'Ask dolphino', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const question = page.getByLabel('Ask a financial question', { exact: true });
  const consent = page.getByRole('checkbox', {
    name: 'I agree to share authorized results with the configured model.'
  });
  await question.fill(spendingQuestion);
  await expect(dialog.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  await consent.check();
  await question.press('Enter');
  await expect(dialog.locator('.assistant-message-assistant')).toContainText('AUD 23.00');
  await expect(dialog.locator('.assistant-message-assistant')).toContainText('1–31 August 2026');
  await expect(dialog.locator('.assistant-citations')).toContainText('2026-08-01 — 2026-08-31 · America/Los_Angeles');
  assert.equal(f.calls.length, 3);
  const reportLink = dialog.getByRole('link', { name: 'Download authorized report' }).last();
  const response = await context.request.get(f.url + (await reportLink.getAttribute('href')));
  assert.equal(response.status(), 200);
  assert.equal((await response.json()).data.totals.expensesMinor, '2300');
  await dialog.getByRole('button', { name: 'New', exact: true }).click();
  f.scenario('provider-failure');
  await consent.check();
  await question.fill(spendingQuestion);
  await question.press('Enter');
  await expect(dialog.getByRole('alert')).toContainText('Assistant provider unavailable');
  await expect(dialog.getByRole('alert')).toContainText('Reference:');
  assert.ok(!(await dialog.innerText()).includes('synthetic-never-send'));
  f.scenario('direct');
  await dialog.getByRole('button', { name: 'Retry question' }).click();
  await expect(dialog.locator('.assistant-message-assistant')).toContainText('AUD 23.00');
  assert.equal(f.calls.length, 2);
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.equal(await page.locator('body').evaluate((body) => body.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: `/tmp/dolphino-assistant-spending-${width}.png` });
  }

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: 'Ask dolphino', exact: true })).toBeFocused();
  await noStorage();
  assert.ok(assets.size > 0);
  assert.deepEqual(external, []);
  assert.deepEqual(errors, []);
  console.log(
    'Compiled assistant spending passed: exact typo question, household calendar, real scoped PostgreSQL total, Bedrock Converse replay, authorized report, recoverable provider error/retry, keyboard and 1440/390/320px; no live integrations or browser storage.'
  );
} finally {
  await context.close();
  await browser.close();
  await f.close();
}
