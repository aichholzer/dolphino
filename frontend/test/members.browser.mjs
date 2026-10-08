import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { chromium } from './browser.mjs';
import { categoryFixture } from '../../backend/test/helpers/category-fixture.mjs';
import { createUserManagement } from '../../backend/src/lib/users.mjs';
import { installBrowserStorageGuard } from './browser-storage-guard.mjs';

// Settings > Members against real HTTP, sessions and PostgreSQL. Mail is captured in memory.
const mail = [];
const f = await categoryFixture({
  appOptions: async ({ pool }) => {
    const users = createUserManagement({
      pool,
      config: { mode: 'live', origin: 'https://dolphino.test' },
      settings: {
        getValue: async () => ({ from: 'dolphino@example.test' }),
        getSecret: async () => 'smtps://synthetic:synthetic@smtp.example.test:465'
      },
      sendMail: async (message) => {
        mail.push(message);
      }
    });
    await users.init();
    return { users };
  }
});
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox']
});
const context = await browser.newContext({ viewport: { width: 1360, height: 980 } });
const errors = [],
  external = [];
try {
  const [name, value] = f.cookies.admin.split('=');
  await context.addCookies([{ name, value, url: f.url, httpOnly: true, sameSite: 'Strict' }]);
  await context.route('**/*', async (route) => {
    if (new URL(route.request().url()).origin !== f.url) {
      external.push(route.request().url());
      await route.abort();
    } else {
      await route.continue();
    }
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('response', (r) => {
    if (r.status() >= 500) {
      errors.push(`${r.status()} ${r.url()}`);
    }
  });
  const noStorage = await installBrowserStorageGuard(page);
  const status = page.getByRole('status').filter({ hasText: 'User settings updated.' });
  const person = (email) => page.locator('.health-account').filter({ hasText: email }).first();
  const invitation = (text) =>
    page
      .locator('.health-account')
      .filter({ has: page.locator('strong', { hasText: 'new@example.test' }) })
      .filter({ hasText: text });
  await page.goto(f.url + '/#settings/members');
  await expect(page.getByRole('heading', { name: 'Household accounts', exact: true })).toBeVisible();
  await expect(page.getByText('No invitations yet.', { exact: true })).toBeVisible();
  await expect(person('admin@example.test')).toContainText('Admin · You');
  await expect(person('admin@example.test').getByRole('button', { name: 'Grant administrator' })).toHaveCount(0);
  await expect(person('admin@example.test').getByRole('button', { name: 'Revoke administrator' })).toBeDisabled();
  await expect(person('admin@example.test').getByRole('button', { name: 'Disable account' })).toBeDisabled();

  // Unsent drafts are guarded like every other settings form.
  await page.getByLabel('Invitation email address').fill('draft@example.test');
  page.once('dialog', (d) => d.dismiss());
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link', { name: /^Data/ }).click();
  await expect(page).toHaveURL(`${f.url}/#settings/members`);

  // Invite a member with account and budget access.
  await page.getByLabel('Invitation email address').fill('new@example.test');
  await page.getByLabel('Invitation role').selectOption('member');
  await page.getByLabel('Invitation account visible access').selectOption('view');
  await page.getByLabel(`Invitation budget ${f.budget.id} access`).selectOption('edit');
  await page.getByRole('button', { name: 'Send invitation email', exact: true }).click();
  await expect(status).toBeVisible();
  await expect(page.getByLabel('Invitation email address')).toHaveValue('');
  await expect(invitation('Member invitation · sent')).toHaveCount(1);
  assert.equal(mail.length, 1);
  assert.equal(mail[0].to, 'new@example.test');
  assert.match(mail[0].text, /https:\/\/dolphino\.test\/activate#token=/);
  const stored = (await f.pool.query("SELECT grants FROM household_invitations WHERE email='new@example.test'"))
    .rows[0];
  assert.deepEqual(stored.grants, {
    accounts: [{ accountId: 'visible', access: 'view' }],
    budgets: [{ budgetId: f.budget.id, access: 'edit' }]
  });

  // Server refusals reach the page.
  await page.getByLabel('Invitation email address').fill('viewer@example.test');
  await page.getByRole('button', { name: 'Send invitation email', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('User already exists; use password reset');
  await page.getByLabel('Invitation email address').fill('');

  // Resend retires the first link; revoke ends the second.
  await invitation('sent').getByRole('button', { name: 'Resend email', exact: true }).click();
  await expect(status).toBeVisible();
  await expect(invitation('Revoked')).toHaveCount(1);
  await expect(invitation('sent')).toHaveCount(1);
  assert.equal(mail.length, 2);
  await invitation('sent').getByRole('button', { name: 'Revoke invitation', exact: true }).click();
  await expect(invitation('Revoked')).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Resend email', exact: true })).toHaveCount(0);

  // Grants, administrator role and disabling, each saved through the API.
  const viewer = person('viewer@example.test');
  await viewer.getByText('Manage financial access', { exact: true }).click();
  await viewer.getByLabel('viewer@example.test account visible access').selectOption('edit');
  await viewer.getByLabel(`viewer@example.test budget ${f.budget.id} access`).selectOption('view');
  await viewer.getByRole('button', { name: 'Save access for viewer@example.test', exact: true }).click();
  await expect(status).toBeVisible();
  assert.deepEqual(
    (
      await f.pool.query(
        'SELECT permission FROM user_account_grants WHERE user_id=$1 UNION ALL SELECT permission FROM user_budget_grants WHERE user_id=$1',
        [f.users.viewer.id]
      )
    ).rows.map((r) => r.permission),
    ['edit', 'view']
  );
  const none = person('none@example.test');
  await none.getByRole('button', { name: 'Grant administrator', exact: true }).click();
  await expect(none).toContainText('none@example.test · Administrator');
  await expect(none.getByText('Manage financial access')).toHaveCount(0);
  await none.getByRole('button', { name: 'Revoke administrator', exact: true }).click();
  await expect(none).toContainText('none@example.test · Member');
  await none.getByRole('button', { name: 'Disable account', exact: true }).click();
  await expect(none).toContainText('· Disabled');
  await expect(none.getByRole('button', { name: 'Email password reset', exact: true })).toBeDisabled();
  await none.getByRole('button', { name: 'Enable account', exact: true }).click();
  await expect(none.getByRole('button', { name: 'Disable account', exact: true })).toBeVisible();

  // Password reset mails a reset link and lists it.
  await person('budget@example.test').getByRole('button', { name: 'Email password reset', exact: true }).click();
  await expect(status).toBeVisible();
  assert.equal(mail.at(-1).to, 'budget@example.test');
  assert.match(mail.at(-1).text, /https:\/\/dolphino\.test\/reset-password#token=/);
  await expect(
    page
      .locator('.health-account')
      .filter({ hasText: 'budget@example.test' })
      .filter({ hasText: 'Password reset · sent' })
  ).toHaveCount(1);
  for (const message of mail) {
    const token = message.text.match(/#token=([A-Za-z0-9_-]+)/)[1];
    assert.ok(!(await page.content()).includes(token), 'no mailed link reaches the page');
  }

  await noStorage();
  assert.deepEqual(external, []);
  assert.deepEqual(errors, []);
  console.log(
    'PASS members browser: invite with grants, duplicate refusal, resend, revoke, grant edits, administrator role, disable/enable, password reset, draft guard'
  );
} finally {
  await context.close();
  await browser.close();
  await f.close();
}
