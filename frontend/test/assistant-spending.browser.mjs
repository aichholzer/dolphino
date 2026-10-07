import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { chromium } from './browser.mjs';
import {
  assistantSpendingFixture,
  spendingQuestion,
  spendingMarkdown
} from '../../backend/test/helpers/assistant-spending-fixture.mjs';
import { installBrowserStorageGuard } from './browser-storage-guard.mjs';

const f = await assistantSpendingFixture('bedrock');
f.scenario('markdown');
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
  await question.fill(spendingQuestion);
  await expect(dialog.getByRole('checkbox')).toHaveCount(0);
  const sent = page.waitForResponse((response) => response.url().endsWith('/messages'));
  await question.press('Enter');
  const wire = await (await sent).json();
  assert.equal(wire.reply, spendingMarkdown, 'Provider Markdown reaches JSON unchanged');
  assert.equal(wire.chat.messages.at(-1).content, spendingMarkdown);
  await expect(dialog.locator('.assistant-message-assistant')).toContainText('AUD 23.00');
  await expect(dialog.locator('.assistant-markdown strong').first()).toHaveText('AUD 23.00');
  await expect(dialog.locator('.assistant-markdown em')).toHaveText('Eating out');
  await expect(dialog.locator('.assistant-markdown li')).toHaveCount(2);
  await expect(dialog.locator('.assistant-message-assistant')).toContainText('1–31 August 2026');
  await expect(dialog.locator('.assistant-citations')).toContainText('2026-08-01 to 2026-08-31 · America/Los_Angeles');
  assert.equal(f.calls.length, 3);
  const reportLink = dialog.getByRole('link', { name: 'Download authorized report' }).last();
  const response = await context.request.get(f.url + (await reportLink.getAttribute('href')));
  assert.equal(response.status(), 200);
  assert.equal((await response.json()).data.totals.expensesMinor, '2300');
  const saved = await context.request.get(`${f.url}/api/assistant/chats/${wire.chat.id}`);
  assert.equal(saved.status(), 200);
  assert.equal((await saved.json()).messages.at(-1).content, spendingMarkdown, 'Chat retains exact provider text');
  const stranger = await browser.newContext();
  try {
    const denied = await stranger.request.get(`${f.url}/api/assistant/chats/${wire.chat.id}`);
    assert.equal(denied.status(), 401);
  } finally {
    await stranger.close();
  }

  await dialog.getByRole('button', { name: 'New', exact: true }).click();
  f.scenario('provider-failure');
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
    'Compiled assistant spending passed: exact provider Markdown preserved in HTTP/private chat, semantic bold/emphasis/lists, unauthenticated denial, exact typo question, household calendar, real scoped PostgreSQL total, Bedrock Converse replay, authorized report, recoverable provider error/retry, keyboard and 1440/390/320px; no live integrations or browser storage.'
  );
} finally {
  await context.close();
  await browser.close();
  await f.close();
}
