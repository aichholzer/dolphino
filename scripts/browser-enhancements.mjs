import { installBrowserStorageGuard } from '../frontend/test/browser-storage-guard.mjs';
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
  args: ['--no-sandbox']
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const assertPageStorageUnused = await installBrowserStorageGuard(page);
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const calls = [];
let enabled = true;
let label = 'Everyday account';
const moneyReport = {
  incomeMinor: '100000',
  expensesMinor: '12345',
  netMinor: '87655',
  pendingMinor: '0',
  transactionIds: { income: ['t1'], expenses: ['t2'] },
  categories: [],
  trend: [],
  coverage: { reason: 'Synthetic browser test data' }
};
const provider = {
  provider: 'openai',
  model: 'synthetic-model',
  enabled: false,
  autoApply: false,
  dailyRequestLimit: 20,
  batchSize: 5,
  encryptionAvailable: true,
  credentialsAvailable: true,
  configured: true,
  regionCatalog: {
    regions: [{ id: 'ap-southeast-2', label: 'Asia Pacific (Sydney)' }]
  },
  credentials: { apiKey: { configured: true, masked: '••••••••' } }
};
await page.route('**/api/**', async (route) => {
  const req = route.request(),
    url = new URL(req.url()),
    path = url.pathname;
  calls.push({
    path,
    query: url.search,
    method: req.method(),
    body: req.postDataJSON()
  });
  let data = {};
  if (path === '/api/session') {
    data = {
      authenticated: true,
      user: {
        id: 'admin-test',
        email: 'admin@example.com',
        name: 'Admin',
        role: 'admin'
      },
      demo: false,
      currency: 'AUD',
      timeZone: 'Australia/Brisbane'
    };
  } else if (path === '/api/dashboard') {
    data = {
      ...moneyReport,
      startDate: '2026-08-01',
      endDate: '2026-09-30',
      monthly: [
        { ...moneyReport, month: '2026-08', partial: false },
        { ...moneyReport, month: '2026-09', partial: true }
      ]
    };
  } else if (path === '/api/accounts') {
    data = {
      accounts: [
        {
          id: 'a1',
          name: label,
          description: 'Daily expenses',
          enabled,
          currency: 'AUD',
          balanceMinor: '456700'
        }
      ]
    };
  } else if (path === '/api/accounts/a1') {
    const b = req.postDataJSON();
    enabled = b.enabled ?? enabled;
    label = b.label ?? label;
    data = { message: 'Account saved' };
  } else if (path === '/api/transactions') {
    data = {
      transactions: [],
      total: 101,
      page: Number(url.searchParams.get('page') || 1),
      pageSize: 50,
      totalPages: 3
    };
  } else if (path === '/api/settings/assistant') {
    data = {
      provider: 'openai',
      model: 'synthetic-assistant-model',
      enabled: false,
      dataSharingAcknowledged: false,
      dailyRequestsPerUser: 10,
      maxToolCalls: 4,
      maxRounds: 3,
      maxOutputTokens: 1024,
      configured: false,
      credentials: {},
      tools: [{ name: 'account_balances', description: 'Read authorized balances' }]
    };
  } else if (path === '/api/settings/provider') {
    if (req.method() === 'PUT') {
      Object.assign(provider, req.postDataJSON(), { apiKey: undefined });
    }

    data = provider;
  } else if (path === '/api/settings/provider/test-model') {
    data = { message: 'Synthetic model test passed' };
  } else if (path === '/api/settings/webhook') {
    data = {
      state: 'registered',
      destinationId: 'evd_synthetic',
      publicBaseUrl: 'https://dolphino.example.com',
      pingReceived: false,
      pingEventId: null
    };
  } else if (path === '/api/settings/webhook/register') {
    data = { message: 'Synthetic registration reused' };
  } else if (path === '/api/settings/webhook/test') {
    data = { message: 'Synthetic test event queued' };
  } else if (path === '/api/settings/notifications') {
    data = {
      smtp: {
        enabled: false,
        from: 'sender@example.com',
        recipients: ['recipient@example.com'],
        credentialConfigured: true
      },
      telegram: { enabled: false, paired: false },
      pendingCount: 0,
      failedCount: 0
    };
  } else if (path === '/api/notifications/deliveries') {
    data = [];
  } else if (path === '/api/notifications/test') {
    data = { message: 'Synthetic delivery queued' };
  } else if (path === '/api/settings/telegram/pair') {
    data = {
      pairingId: 'synthetic-pair',
      command: '/dolphino_pair@testbot synthetic-nonce',
      deepLink: 'https://t.me/testbot?startgroup=synthetic-nonce',
      expiresAt: '2026-09-30T15:00:00Z'
    };
  } else if (path === '/api/settings/telegram/poll') {
    data = {
      pairingId: 'synthetic-pair',
      candidate: {
        chatId: '-123456',
        title: 'Fictional household',
        type: 'group'
      }
    };
  } else if (path === '/api/settings/telegram/confirm') {
    data = { message: 'Synthetic group confirmed' };
  } else if (path === '/api/import-health') {
    data = {
      accounts: [
        {
          id: 'a1',
          name: 'Household',
          currency: 'AUD',
          postedCount: 25,
          pendingCount: 2
        }
      ],
      jobs: []
    };
  } else if (path === '/api/import-health/backfill') {
    data = { message: 'Synthetic history queued' };
  } else if (path === '/api/settings') {
    data = {};
  }

  await route.fulfill({ json: data });
});
try {
  await page.goto(process.env.DOLPHINO_TEST_URL || 'http://localhost:3001');
  await page.getByLabel('Overview period').selectOption('3');
  await page.getByText('Partial month', { exact: true }).waitFor();
  assert(calls.some((c) => c.path === '/api/dashboard' && c.query.includes('months=3')));
  await page.getByRole('button', { name: 'Accounts', exact: true }).click();
  await page.getByRole('button', { name: 'Edit account Everyday account', exact: true }).click();
  await page.getByLabel('Account label', { exact: true }).fill('Household');
  await page.getByRole('button', { name: 'Save account', exact: true }).click();
  await page.getByRole('button', { name: 'View transactions for Household' }).click();
  await page.getByRole('checkbox', { name: 'All imported history' }).waitFor();
  assert(
    calls.some(
      (c) => c.path === '/api/transactions' && c.query.includes('accountId=a1') && c.query.includes('allHistory=true')
    )
  );
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByText('Page 2', { exact: true }).waitFor();
  await page.getByLabel('Transactions from').fill('2026-01-01');
  await page.getByText('Page 1', { exact: true }).waitFor();
  await page
    .getByRole('button', {
      name: 'Settings → Import health & history → backfill',
      exact: true
    })
    .click();
  await page.getByLabel('Assistant OpenAI API key', { exact: true }).fill('synthetic-assistant-key');
  await page.getByRole('button', { name: 'Save assistant settings', exact: true }).click();
  await page.getByText('Assistant settings saved.', { exact: true }).waitFor();
  await expect(page.getByLabel('Assistant OpenAI API key', { exact: true })).toHaveValue('');
  assert(
    calls.some(
      (c) => c.path === '/api/settings/assistant' && c.method === 'PUT' && c.body.apiKey === 'synthetic-assistant-key'
    )
  );
  await page.getByLabel('OpenAI API key', { exact: true }).waitFor();
  await expect(page.getByLabel('OpenAI API key', { exact: true })).toHaveValue('');
  await page.getByLabel('OpenAI API key', { exact: true }).fill('synthetic-browser-only');
  await page.getByRole('button', { name: 'Save provider settings', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Settings updated.' }).waitFor();
  await expect(page.getByLabel('OpenAI API key', { exact: true })).toHaveValue('');
  await page
    .getByRole('button', {
      name: 'Test saved model · may incur cost',
      exact: true
    })
    .click();
  await page.getByText('Synthetic model test passed', { exact: true }).waitFor();
  assert(calls.some((c) => c.path === '/api/settings/provider/test-model' && c.body.acknowledgeCost === true));
  await page.getByRole('button', { name: 'Register / reuse destination', exact: true }).click();
  await page
    .getByRole('status')
    .filter({
      hasText: 'Thin-event notifications registered/reused: sync_run.succeeded and connection.refreshed'
    })
    .waitFor();
  await page.getByLabel('Provider', { exact: true }).selectOption('bedrock');
  await page.getByLabel('AWS region', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('AWS secret access key', { exact: true }).inputValue(), '');
  await page.getByLabel('AWS region', { exact: true }).selectOption('ap-southeast-2');
  assert.equal(await page.getByLabel('Session token', { exact: false }).count(), 0);
  await page.getByRole('checkbox', { name: 'Budget period', exact: true }).uncheck();
  await page.getByLabel('SMTP connection URL', { exact: true }).fill('smtps://synthetic:only@mail.example.com:465');
  await page.getByRole('button', { name: 'Save notification settings', exact: true }).click();
  assert(
    calls.some(
      (c) => c.path === '/api/settings/notifications' && c.method === 'PUT' && !c.body.summaryFields.includes('period')
    )
  );
  await page.getByRole('button', { name: 'Pair Telegram group', exact: true }).click();
  await page.getByRole('button', { name: 'Check for group', exact: true }).click();
  await page.getByText('Fictional household', { exact: true }).waitFor();
  await page
    .getByRole('button', {
      name: 'Confirm group and enable Telegram alerts',
      exact: true
    })
    .click();
  await page.getByText('Synthetic group confirmed', { exact: true }).waitFor();
  assert(
    calls.some(
      (c) =>
        c.path === '/api/settings/telegram/confirm' &&
        c.body.chatId === '-123456' &&
        c.body.pairingId === 'synthetic-pair'
    )
  );
  await page.getByRole('button', { name: 'Send email test', exact: true }).click();
  await page.getByText('Synthetic delivery queued', { exact: true }).waitFor();
  await page.getByLabel('Account for history import', { exact: true }).selectOption('a1');
  await page.getByLabel('History from', { exact: true }).fill('2026-01-01');
  await page.getByLabel('History to', { exact: true }).fill('2026-02-01');
  await page.getByRole('button', { name: 'Queue history import', exact: true }).click();
  await page.getByText('Synthetic history queued', { exact: true }).waitFor();
  assert.equal(await page.locator('body').evaluate((e) => e.scrollWidth <= innerWidth), true);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(250);
  assert.equal(
    await page.locator('body').evaluate((e) => e.scrollWidth <= innerWidth),
    true,
    'settings mobile overflow'
  );
  await page.screenshot({
    path: 'artifacts/dolphino-settings-mobile.png',
    fullPage: true
  });
  assert.deepEqual(errors, []);
  await assertPageStorageUnused();
  console.log(
    'Enhancement browser checks passed: periods, edit/card scope, pagination/date reset, write-only credentials, synthetic model acknowledgment, webhook reuse, Bedrock region fields, SMTP settings/test, Telegram group confirmation, bounded backfill, desktop/mobile overflow. All API calls mocked.'
  );
} finally {
  await browser.close();
}
