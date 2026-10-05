import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { categoryFixture } from '../../backend/test/helpers/category-fixture.mjs';
import { money } from '../src/money.mjs';
import { installBrowserStorageGuard } from './browser-storage-guard.mjs';

const fixture = await categoryFixture();
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox']
});
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const errors = [];
const unexpected = [];
const assets = new Set();
try {
  const baseline = await fixture.json('admin', '/api/dashboard?month=2026-09&months=1&currency=AUD');
  const memberBaseline = await fixture.json('viewer', '/api/dashboard?month=2026-09&months=1&currency=AUD');
  for (const [month, amountMinor] of [
    ['04', '-9999'],
    ['05', '-1001'],
    ['06', '-2002'],
    ['07', '-3003'],
    ['08', '-4004'],
    ['10', '-9999']
  ]) {
    await fixture.store.ingest({
      ...fixture.base,
      sourceId: `period-${month}`,
      date: `2026-${month}-01`,
      description: `Period purchase ${month}`,
      amountMinor
    });
  }

  const expected = (BigInt(baseline.expensesMinor) + 10010n).toString();
  const member = await fixture.json('viewer', '/api/dashboard?month=2026-09&months=5&currency=AUD');
  assert.equal(member.expensesMinor, (BigInt(memberBaseline.expensesMinor) + 10010n).toString());
  assert.ok(!member.transactionIds.expenses.includes(fixture.secret.id));
  assert.equal((await fixture.http('anonymous', '/api/dashboard?month=2026-09&months=5')).status, 401);
  for (const months of ['0', '7', '-1', '5.5', 'bad']) {
    assert.equal((await fixture.http('admin', `/api/dashboard?month=2026-09&months=${months}`)).status, 400);
  }

  const [name, value] = fixture.cookies.admin.split('=');
  await context.addCookies([{ name, value, url: fixture.url, httpOnly: true, sameSite: 'Strict' }]);
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== fixture.url || /^\/(src|@vite|@id|node_modules)\//.test(url.pathname)) {
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
  const noStorage = await installBrowserStorageGuard(page);
  await page.goto(fixture.url + '/#overview');
  await expect(page.locator('.monthly-comparison tbody tr')).toHaveCount(1);
  await page.getByLabel('Reporting month', { exact: true }).fill('2026-09');
  const response = page.waitForResponse((r) => {
    const url = new URL(r.url());
    return (
      url.pathname === '/api/dashboard' &&
      url.searchParams.get('months') === '5' &&
      url.searchParams.get('month') === '2026-09'
    );
  });
  await page.getByLabel('Overview period', { exact: true }).selectOption('5');
  const result = await response;
  assert.equal(result.status(), 200);
  const report = await result.json();
  assert.equal(report.expensesMinor, expected);
  assert.deepEqual(
    report.monthly.map((row) => row.month),
    ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09']
  );
  assert.deepEqual(
    report.monthly.map((row) => row.expensesMinor),
    ['1001', '2002', '3003', '4004', baseline.expensesMinor]
  );
  await expect(page.locator('.period-caption')).toContainText('2026-05-01 to 2026-09-30 · 5 months');
  await expect(page.locator('.monthly-comparison tbody tr')).toHaveCount(5);
  await expect(page.locator('.metric').filter({ hasText: 'Total spending' })).toContainText(money(expected, 'AUD'));
  for (const width of [1440, 900, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    const header = page.locator('header.topbar');
    const search = page.getByRole('search', { name: 'Global transaction search' });
    await expect(search).toBeVisible();
    await expect(header.locator('.breadcrumb')).toHaveCount(0);
    await expect(header).not.toContainText('dolphino >');
    const left = await header.evaluate(
      (element) => element.getBoundingClientRect().left + parseFloat(getComputedStyle(element).paddingLeft)
    );
    assert.ok(
      Math.abs((await search.boundingBox()).x - left) <= 1,
      `Search must align with header padding at ${width}px`
    );
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    if (width > 680) {
      await expect(page.getByRole('button', { name: 'Open menu', exact: true })).toBeHidden();
      assert.ok(Math.abs((await search.boundingBox()).y - (await header.boundingBox()).y) < 30);
    } else {
      const menu = page.getByRole('button', { name: 'Open menu', exact: true });
      await expect(menu).toBeVisible();
      await expect(menu).toHaveAttribute('aria-controls', 'workspace-navigation');
      await expect(menu).toHaveAttribute('aria-expanded', 'false');
      await menu.focus();
      await page.keyboard.press('Enter');
      await expect(menu).toHaveAttribute('aria-expanded', 'true');
      await page.locator('#workspace-navigation').getByRole('button', { name: 'Accounts', exact: true }).click();
      await expect(menu).toHaveAttribute('aria-expanded', 'false');
      await menu.click();
      await page.locator('#workspace-navigation').getByRole('button', { name: 'Overview', exact: true }).click();
      await expect(menu).toHaveAttribute('aria-expanded', 'false');
      await expect(page.getByLabel('Overview period')).toHaveValue('5');
      await expect(page.locator('.monthly-comparison tbody tr')).toHaveCount(5);
    }
  }

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('.monthly-comparison tbody tr').filter({ hasText: '2026-05' }).getByRole('button').nth(1).click();
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await expect(page.locator('tbody')).toContainText('Period purchase 05');
  await page.getByLabel('Search all transactions', { exact: true }).fill('Period purchase');
  await page.getByRole('button', { name: 'Run global search', exact: true }).click();
  await expect(page.getByLabel('All imported history')).toBeChecked();
  await expect(page.locator('tbody tr')).toHaveCount(6);
  await noStorage();
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  assert.ok(assets.size >= 2);
  console.log(
    'PASS compiled + real PostgreSQL: five-month Overview totals/monthly rows/boundaries/drilldown, scoped access, invalid periods, left-aligned header at 1440/900/390/320px, no breadcrumb, keyboard mobile menu, global scope reset, no persistent storage or external requests'
  );
} finally {
  await context.close();
  await browser.close();
  await fixture.close();
}
