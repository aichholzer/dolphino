import { installBrowserStorageGuard } from './browser-storage-guard.mjs';
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
  args: ['--no-sandbox']
});
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const assertPageStorageUnused = await installBrowserStorageGuard(page);
const calls = [],
  errors = [];
page.on('pageerror', (e) => errors.push(e.message));
let session = { authenticated: false, setupRequired: true, demo: false };
const admin = {
  id: 'admin',
  email: 'admin@example.com',
  name: 'Synthetic Admin',
  role: 'admin'
};
await page.route('**/api/**', async (route) => {
  const req = route.request(),
    path = new URL(req.url()).pathname,
    b = req.postDataJSON();
  calls.push({ path, body: b });
  let data = {};
  if (path === '/api/session') {
    data = session;
  } else if (path === '/api/auth/bootstrap') {
    session = { authenticated: true, user: admin, demo: false };
    data = { ok: true, user: admin };
  } else if (path === '/api/auth/activate') {
    session = { authenticated: false, demo: false };
    data = { ok: true };
  } else if (path === '/api/login') {
    session = {
      authenticated: true,
      user: { ...admin, role: 'member' },
      demo: false
    };
    data = { ok: true };
  } else if (path === '/api/auth/change-password') {
    session = { authenticated: false, demo: false };
    data = { ok: true };
  } else if (path === '/api/logout') {
    session = { authenticated: false, demo: false };
    data = { ok: true };
  } else if (path === '/api/dashboard') {
    data = { incomeMinor: '0', expensesMinor: '0', netMinor: '0' };
  } else if (path === '/api/transactions') {
    data = {
      transactions: [
        {
          id: 'tx-one',
          accountId: 'account-one',
          description: 'Synthetic purchase',
          date: '2026-09-01',
          amountMinor: '-100',
          currency: 'AUD',
          kind: 'expense',
          status: 'posted',
          category: 'Other'
        }
      ],
      total: 1
    };
  } else if (path === '/api/budgets') {
    data = {
      budgets: [
        {
          id: 'budget-one',
          category: 'Groceries',
          capMinor: '10000',
          availableMinor: '10000',
          spentMinor: '100',
          remainingMinor: '9900',
          access: 'view'
        }
      ]
    };
  } else if (path === '/api/users/grant-options') {
    data = {
      accounts: [{ id: 'account-one', name: 'Household account', currency: 'AUD' }],
      budgets: [
        {
          id: 'budget-one',
          category: 'Groceries',
          month: '2026-09',
          currency: 'AUD'
        }
      ]
    };
  } else if (path === '/api/users') {
    data = {
      users: [
        admin,
        {
          id: 'member',
          email: 'member@example.com',
          name: 'Member',
          role: 'member',
          disabled: false
        }
      ],
      invitations: []
    };
  } else if (path === '/api/settings/redbark') {
    data = {
      version: '2026-10-01.wattle',
      backfillDays: 90,
      encryptionAvailable: true,
      credentialsAvailable: true,
      credentials: {}
    };
  } else if (path === '/api/settings/pocketsmith') {
    data = { configured: false, enabled: false, backfillDays: 90, accounts: [] };
  } else if (path === '/api/settings/simplefin') {
    data = { configured: false, enabled: false, backfillDays: 30, accounts: [] };
  } else if (path === '/api/settings/notifications') {
    data = { smtp: {}, telegram: {} };
  } else if (path === '/api/notifications/deliveries') {
    data = [];
  } else if (path === '/api/settings/provider') {
    data = {
      provider: 'openai',
      model: '',
      encryptionAvailable: false,
      credentials: {}
    };
  } else if (path === '/api/users/invitations') {
    data = { message: 'Synthetic invitation queued' };
  } else if (path === '/api/users/member') {
    data = { message: 'Synthetic role updated' };
  }

  await route.fulfill({ json: data });
});
try {
  await page.goto(process.env.DOLPHINO_TEST_URL || 'http://localhost:3001');
  await page.getByRole('heading', { name: 'Make yourself at home.' }).waitFor();
  await page.getByLabel('Email address', { exact: true }).fill('admin@example.com');
  await page.getByLabel('Your name', { exact: true }).fill('Synthetic Admin');
  await page.getByLabel('Server bootstrap token', { exact: true }).fill('synthetic-bootstrap-only');
  await page.getByLabel('Choose a password', { exact: true }).fill('synthetic-password-1234');
  await page.getByLabel('Confirm password', { exact: true }).fill('synthetic-password-1234');
  await page.getByRole('button', { name: 'Create administrator', exact: true }).click();
  await page.getByText('Total income', { exact: true }).waitFor();
  assert(calls.some((c) => c.path === '/api/auth/bootstrap' && c.body.bootstrapToken === 'synthetic-bootstrap-only'));
  await page.getByRole('button', { name: 'Open menu', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('link', { name: /^Members/ }).click();
  await page.getByLabel('Invitation email address', { exact: true }).fill('member@example.com');
  await page.getByLabel('Invitation account account-one access', { exact: true }).selectOption('view');
  await page.getByRole('button', { name: 'Send invitation email', exact: true }).click();
  await page.getByText('Synthetic invitation queued', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Grant administrator', exact: true }).click();
  await page.getByText('Synthetic role updated', { exact: true }).waitFor();
  assert(calls.some((c) => c.path === '/api/users/member' && c.body.role === 'admin'));
  session = { authenticated: false, demo: false };
  await page.goto((process.env.DOLPHINO_TEST_URL || 'http://localhost:3001') + '/activate#token=synthetic-invite-only');
  await page.getByRole('heading', { name: 'Join your household.' }).waitFor();
  assert.equal(new URL(page.url()).hash, '');
  await page.getByLabel('Your name', { exact: true }).fill('Synthetic Member');
  await page.getByLabel('Choose a password', { exact: true }).fill('synthetic-password-1234');
  await page.getByLabel('Confirm password', { exact: true }).fill('synthetic-password-1234');
  await page.getByRole('button', { name: 'Activate my account', exact: true }).click();
  await page.getByRole('heading', { name: 'Welcome home.' }).waitFor();
  await page.getByLabel('Email address', { exact: true }).fill('member@example.com');
  await page.getByLabel('Your password', { exact: true }).fill('synthetic-password-1234');
  const start = calls.length;
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('heading', { name: 'Your account is ready.' }).waitFor();
  assert(
    !calls
      .slice(start)
      .some((c) => ['/api/dashboard', '/api/accounts', '/api/settings', '/api/transactions'].includes(c.path)),
    'member must not fetch financial or settings data while access pending'
  );
  assert.equal(await page.getByRole('button', { name: 'Settings', exact: true }).count(), 0);
  await page.getByLabel('Current password', { exact: true }).fill('synthetic-password-1234');
  await page.getByLabel('New password', { exact: true }).fill('synthetic-new-password-5678');
  await page.getByLabel('Confirm new password', { exact: true }).fill('synthetic-new-password-5678');
  await page.getByRole('button', { name: 'Update password', exact: true }).click();
  await page.getByRole('heading', { name: 'Welcome home.' }).waitFor();
  await page.screenshot({
    path: 'artifacts/dolphino-login-mobile.png',
    fullPage: true
  });
  session = {
    authenticated: true,
    user: { ...admin, role: 'member' },
    demo: false,
    permissions: {
      financialAccess: true,
      accounts: [],
      budgets: [{ budgetId: 'budget-one', access: 'view' }]
    }
  };
  await page.goto(process.env.DOLPHINO_TEST_URL || 'http://localhost:3001');
  await page.getByRole('heading', { name: 'Make room for what matters.', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Overview', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Accounts', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Add budget', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'View spending', exact: true }).count(), 0);
  session = {
    authenticated: true,
    user: { ...admin, role: 'member' },
    demo: false,
    permissions: {
      financialAccess: true,
      accounts: [{ accountId: 'account-one', access: 'view' }],
      budgets: []
    }
  };
  await page.goto(process.env.DOLPHINO_TEST_URL || 'http://localhost:3001');
  await page.getByText('Total income', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Budgets', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Rules', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Settings', exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Open menu', exact: true }).click();
  await page.getByRole('button', { name: 'Transactions', exact: true }).click();
  await page.getByText('Synthetic purchase', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Edit Synthetic purchase', exact: true }).count(), 0);
  session.permissions.accounts[0].access = 'edit';
  await page.reload();
  await page.getByText('Synthetic purchase', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Open menu', exact: true }).click();
  await page.getByRole('button', { name: 'Transactions', exact: true }).click();
  const beforeCorrection = calls.length;
  await page.getByRole('button', { name: 'Edit Synthetic purchase', exact: true }).click();
  await page.getByRole('dialog').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Suggest category with AI', exact: true }).count(), 0);
  assert(!calls.slice(beforeCorrection).some((c) => c.path === '/api/settings'));
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await page.locator('body').evaluate((e) => e.scrollWidth <= innerWidth), true);

  assert.deepEqual(errors, []);
  await assertPageStorageUnused();
  console.log(
    'Auth browser checks passed: first-admin bootstrap, invitation email/role controls, fragment activation, email login, member access-pending zero financial requests, password change signs out, budget-only and account-only navigation, mobile layout. All API calls mocked.'
  );
} finally {
  await browser.close();
}
