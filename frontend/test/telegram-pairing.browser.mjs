import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chromium, expect } from '@playwright/test';
import { telegramFixture, syntheticTelegramToken } from '../../backend/test/helpers/telegram-fixture.mjs';
import { verifyTelegramPrivateGroup } from '../../backend/src/lib/telegram.mjs';
import { installBrowserStorageGuard } from './browser-storage-guard.mjs';

const f = await telegramFixture({
  notificationOptions: {
    verifyTelegramGroup: (input) =>
      verifyTelegramPrivateGroup({
        ...input,
        fetchImpl: async () =>
          Response.json({
            ok: true,
            result: { id: -987654321, type: 'supergroup', username: 'synthetic_public_group' }
          })
      })
  }
});
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox']
});
const context = await browser.newContext({ viewport: { width: 1360, height: 1000 } });
const errors = [],
  external = [],
  assets = new Set();
try {
  const [name, value] = f.cookie.split('=');
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
  await page.goto(f.url + '/#settings/notifications');
  const panel = page.locator('.notification-settings');
  const pair = panel.getByRole('button', { name: 'Pair Telegram group', exact: true });
  const enabled = panel.getByLabel('Enable Telegram alerts to the confirmed group');
  await expect(pair).toBeDisabled();
  await expect(enabled).toBeDisabled();
  const token = panel.getByLabel('Telegram bot token', { exact: true });
  await token.fill(syntheticTelegramToken);
  await expect(pair).toBeDisabled();
  await panel.getByLabel('I understand notifications can show', { exact: false }).check();
  await panel.getByRole('button', { name: 'Save notification settings' }).click();
  await expect(token).toHaveValue('');
  await expect(pair).toBeEnabled();
  f.setHook(() => Response.json({ ok: false, error_code: 401, description: syntheticTelegramToken }, { status: 401 }));
  await pair.click();
  await expect(panel.getByRole('alert')).toContainText('Telegram rejected the saved bot token');
  await expect(enabled).toBeDisabled();
  assert.ok(!(await panel.innerText()).includes(syntheticTelegramToken));
  f.setHook(null);
  await pair.click();
  const groupLink = panel.getByRole('link', { name: 'Choose group in Telegram', exact: true });
  await expect(groupLink).toBeVisible();
  const link = new URL(await groupLink.getAttribute('href'));
  assert.equal(link.origin, 'https://t.me');
  assert.equal(link.pathname, '/dolphinoSyntheticBot');
  assert.match(link.searchParams.get('startgroup'), /^[A-Za-z0-9_-]{32}$/);
  await expect(groupLink).toHaveAttribute('target', '_blank');
  await expect(groupLink).toHaveAttribute('rel', 'noreferrer');
  await expect(panel.locator('details code')).toBeHidden();
  await expect(panel).toContainText('You do not need to type /start.');
  await panel.getByRole('button', { name: 'Check for group', exact: true }).click();
  await expect(panel.getByRole('status')).toContainText('No matching group yet.');
  await expect(enabled).toBeDisabled();
  await expect(panel.getByRole('button', { name: 'Confirm group and enable Telegram alerts' })).toHaveCount(0);
  // Reproduce Telegram's documented group-selection update without opening t.me or sending a real message.
  f.setCommand(`/start@${link.pathname.slice(1)} ${link.searchParams.get('startgroup')}`);
  await panel.getByRole('button', { name: 'Check for group', exact: true }).click();
  await expect(panel.getByText('Synthetic private group', { exact: true })).toBeVisible();
  await expect(enabled).toBeDisabled();
  const from = panel.getByLabel('From email address', { exact: true });
  await from.fill('unsaved@example.test');
  await panel.getByRole('button', { name: 'Confirm group and enable Telegram alerts' }).click();
  await expect(enabled).toBeEnabled();
  await expect(enabled).toBeChecked();
  await expect(from).toHaveValue('unsaved@example.test');
  await expect(panel).toContainText('Paired group: Synthetic private group');
  assert.equal((await f.settings.getValue('notifications.smtp')).from, '');
  const alertId = randomUUID();
  await f.pool.query(
    "INSERT INTO budget_alerts(id,mode,currency,month,category,type,amount_minor,message) VALUES($1,'live','AUD','2026-09','Dining','overspend',100,'Synthetic browser alert')",
    [alertId]
  );
  await f.pool.query("INSERT INTO notification_events(alert_id,revision,mode,payload) VALUES($1,1,'live',$2)", [
    alertId,
    {
      category: 'Dining',
      month: '2026-09',
      currency: 'AUD',
      amountMinor: '100',
      state: 'opened'
    }
  ]);
  await f.notifications.processPending();
  await panel.getByRole('button', { name: 'Save notification settings' }).click();
  await expect(panel).toContainText('Telegram delivery stopped: the confirmed group could not be verified as private.');
  await expect(panel.getByRole('button', { name: /^Retry delivery/ })).toBeVisible();
  assert.ok(!(await panel.innerText()).includes(syntheticTelegramToken));
  await expect(panel.getByRole('status')).toContainText('Notification settings updated.');
  // A refreshed page does not retain the raw nonce; restarting provides a fresh manual fallback.
  await pair.click();
  const previousLink = await groupLink.getAttribute('href');
  await page.reload();
  await expect(panel).toContainText('The pairing link is only shown when pairing starts.');
  await expect(groupLink).toHaveCount(0);
  await expect(panel.locator('code')).toHaveCount(0);
  await pair.click();
  assert.notEqual(await groupLink.getAttribute('href'), previousLink);
  await panel.locator('details summary').click();
  const fallback = panel.locator('details code');
  await expect(fallback).toBeVisible();
  await expect(panel).toContainText('A plain /start does not identify this pairing request.');
  f.setCommand(await fallback.innerText());
  await panel.getByRole('button', { name: 'Check for group', exact: true }).click();
  await expect(panel.getByText('Synthetic private group', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Confirm group and enable Telegram alerts' }).click();
  await expect(enabled).toBeChecked();
  await token.fill('123456789:another_synthetic_token_1234567890');
  await expect(pair).toBeDisabled();
  await token.fill('');
  await panel.getByLabel('Clear Telegram bot token').check();
  await expect(pair).toBeDisabled();
  await panel.getByRole('button', { name: 'Save notification settings' }).click();
  await expect(enabled).toBeDisabled();
  await expect(enabled).not.toBeChecked();
  await expect(pair).toBeDisabled();
  await noStorage();
  assert.ok(assets.size > 0);
  assert.deepEqual(external, []);
  assert.deepEqual(errors, []);
  assert.ok(!f.calls.includes('sendMessage'));
  console.log(
    'Telegram production-browser regression passed: saved-token prerequisite, safe rejected-token error, startgroup discovery, explicit confirmation, drafts, refresh/manual fallback and actionable privacy-blocked delivery status; real HTTP/PostgreSQL, no live Telegram or browser storage.'
  );
} finally {
  await context.close();
  await browser.close();
  await f.close();
}
