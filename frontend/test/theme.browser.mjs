import { installBrowserStorageGuard } from './browser-storage-guard.mjs';
import { expect } from '@playwright/test';
import { chromium } from './browser.mjs';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';

// Run against the dedicated fictional demo. Auth states below mock /session only.
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
  args: ['--no-sandbox']
});
const base = process.env.DOLPHINO_TEST_URL || 'http://localhost:3001';
await mkdir('artifacts', { recursive: true });
const page = await browser.newPage({
  viewport: { width: 1440, height: 1000 },
  reducedMotion: 'reduce'
});
const assertPageStorageUnused = await installBrowserStorageGuard(page);
const errors = [];
let reportMonth;
page.on('pageerror', (e) => errors.push(e.message));
const screenshot = async (name, target = page, preserveFocus = false) => {
  if (!preserveFocus) {
    await target.getByRole('heading').first().click();
  }

  await target.screenshot({
    path: `artifacts/${name}.png`,
    fullPage: !name.includes('assistant'),
    animations: 'disabled'
  });
};

const fits = async (name, target = page) => {
  assert(await target.locator('body').evaluate((el) => el.scrollWidth <= innerWidth), `${name}: viewport overflow`);
};

async function fullHeightSidebar(name) {
  const dimensions = await page.locator('.sidebar').evaluate((el) => ({
    sidebar: el.getBoundingClientRect().height,
    page: document.querySelector('.app-shell').getBoundingClientRect().height,
    background: getComputedStyle(el).backgroundColor
  }));
  assert(Math.abs(dimensions.sidebar - dimensions.page) < 2, `${name}: sidebar must span the full document`);
  assert.equal(dimensions.background, 'rgb(255, 255, 255)', 'Sidebar stays light and neutral');
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  const nav = await page.locator('.sidebar-inner').boundingBox();
  assert(nav.y >= -1 && nav.y <= 1, `${name}: navigation remains sticky while page scrolls`);
  await page.evaluate(() => window.scrollTo(0, 0));
}

async function navigate(name) {
  if (page.viewportSize().width <= 680) {
    await page.getByRole('button', { name: 'Open menu', exact: true }).click();
  }

  await page.getByRole('button', { name, exact: true }).click();
  await page.locator('.loading').waitFor({ state: 'hidden' });
}

try {
  await page.goto(base);
  await page.getByText('Total income', { exact: true }).waitFor();
  reportMonth = await page.getByLabel('Reporting month', { exact: true }).inputValue();
  await page.getByText('$6,650.00', { exact: true }).first().waitFor();
  assert(await page.getByText(/fictional demo data/).isVisible(), 'Only fictional demo data is used');
  await fits('desktop overview');
  await fullHeightSidebar('Overview');
  await screenshot('dolphino-desktop');
  const chartColors = await page
    .locator('.category-track > div')
    .evaluateAll((els) => els.map((e) => getComputedStyle(e).backgroundColor));
  assert.equal(new Set(chartColors).size, chartColors.length, 'Six category colors stay distinct');
  for (const name of ['Transactions', 'Accounts', 'Budgets', 'Review', 'Rules', 'Settings']) {
    await navigate(name);
    await fits(`desktop ${name}`);
    if (name === 'Settings') {
      await fullHeightSidebar('Long Settings page');
    }

    await screenshot(`dolphino-${name.toLowerCase()}`);
    if (name === 'Settings') {
      await page
        .locator('.integration-settings')
        .first()
        .screenshot({ path: 'artifacts/dolphino-integration-settings.png' });
    }
  }

  assert(
    await page.getByRole('button', { name: 'Test connection', exact: true }).isDisabled(),
    'Demo connection stays disabled'
  );
  await page.getByRole('button', { name: 'Ask dolphino', exact: true }).click();
  await page.getByRole('heading', { name: 'Your assistant is not enabled yet' }).waitFor();
  assert(await page.getByRole('button', { name: 'Send', exact: true }).isDisabled());
  await screenshot('dolphino-assistant-unconfigured');
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  // The dialog restores focus to its trigger once its close has unmounted the content.
  await expect(
    page.getByRole('button', { name: 'Ask dolphino', exact: true }),
    'Assistant restores focus'
  ).toBeFocused();
  await page.route('**/api/accounts', (r) =>
    r.fulfill({
      status: 503,
      json: { error: 'Database temporarily unavailable' }
    })
  );
  await navigate('Accounts');
  await page.getByRole('alert').filter({ hasText: 'Database temporarily unavailable' }).waitFor();
  await screenshot('dolphino-error-state');
  await page.unroute('**/api/accounts');
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await page.getByText('Everyday · Fictional Bank', { exact: true }).waitFor();
  await navigate('Overview');
  let releaseLoading;
  const loadingGate = new Promise((resolve) => {
    releaseLoading = resolve;
  });
  await page.route('**/api/accounts', async (r) => {
    await loadingGate;
    await r.continue();
  });
  await page.getByRole('button', { name: 'Accounts', exact: true }).click();
  await page.locator('.loading').waitFor({ state: 'visible' });
  await screenshot('dolphino-loading-state');
  releaseLoading();
  await page.getByText('Everyday · Fictional Bank', { exact: true }).waitFor();
  await page.unroute('**/api/accounts');
  await navigate('Overview');
  await page.getByLabel('Reporting month', { exact: true }).fill('2100-01');
  await page.getByText('No posted activity in this period.').waitFor();
  await screenshot('dolphino-empty-state');
  await page.getByLabel('Reporting month', { exact: true }).fill(reportMonth);
  await page.getByText('$6,650.00', { exact: true }).first().waitFor();
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await fits(`${width}px overview`);
    const comparison = page.getByRole('region', {
      name: 'Month-by-month comparison. Scroll horizontally to view all columns.'
    });
    assert(await page.getByText('Scroll sideways to compare all columns', { exact: true }).isVisible());
    await comparison.focus();
    await comparison.press('ArrowRight');
    await page.waitForFunction(() => document.querySelector('.monthly-comparison-scroll').scrollLeft > 0);
    assert(
      await comparison.evaluate((el) => el.scrollWidth > el.clientWidth && el.scrollLeft > 0),
      'Comparison is keyboard-scrollable'
    );
    await comparison.press('ArrowLeft');
    await page.waitForFunction(() => document.querySelector('.monthly-comparison-scroll').scrollLeft === 0);

    if (width === 390) {
      await screenshot('dolphino-mobile');
    }

    for (const name of ['Transactions', 'Accounts', 'Budgets', 'Review', 'Rules', 'Settings']) {
      await navigate(name);
      await fits(`${width}px ${name}`);
      if (width === 390 && name === 'Settings') {
        await screenshot('dolphino-settings-mobile');
      }
    }

    await navigate('Overview');
    await page.getByRole('button', { name: 'Ask dolphino', exact: true }).click();
    await page.getByRole('heading', { name: 'Your assistant is not enabled yet' }).waitFor();
    await fits(`${width}px assistant`);
    if (width === 390) {
      await screenshot('dolphino-assistant-unconfigured-mobile');
    }

    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
  }

  const auth = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: 'reduce'
  });
  const assertAuthStorageUnused = await installBrowserStorageGuard(auth);
  auth.on('pageerror', (e) => errors.push(e.message));
  let setupRequired = false;
  await auth.route('**/api/session', (r) => r.fulfill({ json: { authenticated: false, demo: false, setupRequired } }));
  await auth.goto(base);
  await auth.getByRole('heading', { name: 'Welcome home.' }).waitFor();
  await screenshot('dolphino-login', auth);
  await auth.getByLabel('Email address', { exact: true }).focus();
  assert.equal(
    await auth.getByLabel('Email address', { exact: true }).evaluate((el) => getComputedStyle(el).outlineWidth),
    '3px'
  );
  await screenshot('dolphino-login-focus', auth, true);
  await auth.setViewportSize({ width: 390, height: 844 });
  await fits('mobile login', auth);
  await screenshot('dolphino-login-mobile', auth);
  setupRequired = true;
  await auth.reload();
  await auth.getByRole('heading', { name: 'Make yourself at home.' }).waitFor();
  await fits('mobile initial setup', auth);
  await screenshot('dolphino-setup-mobile', auth);
  assert.deepEqual(errors, []);
  await assertPageStorageUnused();
  await assertAuthStorageUnused();
  console.log(
    'Ocean UI verified at 1440px, 390px and 320px: all seven screens, charts, disabled demo controls, unavailable assistant, Escape/focus restoration, API loading/error/retry, empty period, login and initial setup. Auth states use synthetic session fixtures; no credentials entered or external services called.'
  );
} finally {
  await browser.close();
}
