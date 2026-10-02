import { installBrowserStorageGuard } from '../frontend/test/browser-storage-guard.mjs';
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createCompiledServer } from '../frontend/test/compiled-server.mjs';

// Serve only the local production build. Every API below is synthetic; this
// suite must never depend on a running installation or contact an integration.
const server = await createCompiledServer({ root: fileURLToPath(new URL('../frontend', import.meta.url)) });
await server.listen();
const base = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
  args: ['--no-sandbox']
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
const assertPageStorageUnused = await installBrowserStorageGuard(page);
const errors = [];
const external = [];
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
  discoveryRevision: '1'.repeat(64),
  migration: { status: 'ready', message: null, sources: [] },
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
const notifications = {
  audienceConfirmed: false,
  summaryFields: ['category', 'period', 'amount', 'remaining'],
  smtp: {
    enabled: false,
    from: 'sender@example.com',
    recipients: ['recipient@example.com'],
    credentialConfigured: true,
    credentialsAvailable: true
  },
  telegram: { enabled: false, paired: false, credentialConfigured: false, credentialsAvailable: true },
  pendingCount: 0,
  failedCount: 0
};
const telegramToken = '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'; // Synthetic; never sent to Telegram.
let pairing = null;
await page.context().route('**/*', async (route) => {
  const req = route.request(),
    url = new URL(req.url()),
    path = url.pathname;
  if (url.origin !== base) {
    external.push(url.href);
    await route.abort();
    return;
  }

  if (!path.startsWith('/api/')) {
    await route.continue();
    return;
  }

  calls.push({
    path,
    query: url.search,
    method: req.method(),
    body: req.postDataJSON()
  });
  let data;
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
  } else if (path === '/api/settings/simplefin') {
    data = {
      configured: false,
      backfillDays: 30,
      enabled: false,
      encryptionAvailable: true,
      credentialsAvailable: true,
      accounts: []
    };
  } else if (path === '/api/settings/pocketsmith') {
    data = {
      revision: null,
      configured: false,
      backfillDays: 90,
      enabled: false,
      verified: false,
      encryptionAvailable: true,
      credentialsAvailable: true,
      accounts: []
    };
  } else if (path === '/api/settings/deleted-accounts') {
    data = { accounts: [] };
  } else if (path === '/api/categories') {
    data = { catalog: [] };
  } else if (path === '/api/tags') {
    data = { tags: [] };
  } else if (path === '/api/settings/ai') {
    if (req.method() === 'PUT') {
      provider.discoveryRevision = '2'.repeat(64);
    }

    data = provider;
  } else if (path === '/api/settings/assistant') {
    data = {
      ...provider,
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
  } else if (path === '/api/settings/redbark') {
    data = {
      version: '2026-10-01.wattle',
      backfillDays: 90,
      encryptionAvailable: true,
      credentialsAvailable: true,
      credentials: {}
    };
  } else if (path === '/api/settings/notifications') {
    if (req.method() === 'PUT') {
      const body = req.postDataJSON();
      notifications.audienceConfirmed = body.audienceConfirmed;
      notifications.summaryFields = body.summaryFields;
      Object.assign(notifications.smtp, {
        enabled: body.smtp.enabled,
        from: body.smtp.from,
        recipients: body.smtp.recipients
      });
      notifications.telegram.enabled = body.telegram.enabled;
      if (Object.hasOwn(body.telegram, 'token')) {
        assert.equal(body.telegram.token, telegramToken);
        Object.assign(notifications.telegram, { credentialConfigured: true, enabled: false, paired: false });
        pairing = null;
      }
    }

    data = notifications;
  } else if (path === '/api/notifications/deliveries') {
    data = [];
  } else if (path === '/api/notifications/test') {
    data = { message: 'Synthetic delivery queued' };
  } else if (path === '/api/settings/telegram/pair') {
    if (req.method() === 'POST') {
      assert.equal(notifications.telegram.credentialConfigured, true);
      pairing = {
        pairingId: 'synthetic-pair',
        command: '/pair@testbot synthetic-nonce',
        deepLink: 'https://t.me/testbot?startgroup=synthetic-nonce',
        expiresAt: new Date(Date.now() + 10 * 60000).toISOString()
      };
      data = pairing;
    } else {
      data = { active: !!pairing, ...pairing };
    }
  } else if (path === '/api/settings/telegram/poll') {
    assert.equal(req.postDataJSON().pairingId, pairing.pairingId);
    pairing.candidate = {
      chatId: '-123456',
      title: 'Fictional household',
      type: 'group'
    };
    data = pairing;
  } else if (path === '/api/settings/telegram/confirm') {
    assert.deepEqual(req.postDataJSON(), { pairingId: pairing.pairingId, chatId: pairing.candidate.chatId });
    assert.equal(notifications.audienceConfirmed, true);
    Object.assign(notifications.telegram, { enabled: true, paired: true, chatTitle: pairing.candidate.title });
    pairing = null;
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
  } else {
    errors.push(`Unmocked API request: ${req.method()} ${path}`);
    await route.fulfill({ status: 501, json: { error: 'Missing synthetic API fixture' } });
    return;
  }

  await route.fulfill({ json: data });
});
const settingsNav = page.getByRole('navigation', { name: 'Settings sections' });
async function openSettingsSection(id, label) {
  const link = settingsNav.getByRole('link', { name: new RegExp(`^${label}`) });
  await link.click();
  await expect(page).toHaveURL(`${base}/#settings/${id}`);
  await expect(link).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('.settings-section-heading').getByRole('heading')).toHaveText(label);
}

try {
  await page.goto(base);
  await page.getByLabel('Overview period').selectOption('3');
  await page.getByText('Partial month', { exact: true }).waitFor();
  assert(calls.some((c) => c.path === '/api/dashboard' && c.query.includes('months=3')));
  await page.getByRole('button', { name: 'Accounts', exact: true }).click();
  await page.getByRole('button', { name: 'Edit account Everyday account', exact: true }).click();
  await page.getByLabel('Account label', { exact: true }).fill('Household');
  await page.getByRole('button', { name: 'Save account', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Household', exact: true })).toBeVisible();
  assert(calls.some((c) => c.path === '/api/accounts/a1' && c.method === 'PATCH' && c.body.label === 'Household'));
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
      name: 'Settings → Data → Import health & history → backfill',
      exact: true
    })
    .click();
  await expect(page).toHaveURL(`${base}/#settings/data`);
  await expect(settingsNav.getByRole('link', { name: /^Data/ })).toHaveAttribute('aria-current', 'page');
  await page.getByRole('heading', { name: 'Import health & history', exact: true }).waitFor();
  await openSettingsSection('ai', 'AI features');
  await page.getByLabel('OpenAI API key', { exact: true }).fill('synthetic-browser-only');
  await page.getByRole('button', { name: 'Save AI connection', exact: true }).click();
  await expect(page.getByLabel('OpenAI API key', { exact: true })).toHaveValue('');
  assert(
    calls.some(
      (call) =>
        call.path === '/api/settings/ai' && call.method === 'PUT' && call.body.apiKey === 'synthetic-browser-only'
    )
  );
  await page.getByRole('button', { name: 'Save assistant settings', exact: true }).click();
  await page.getByText('Assistant settings saved.', { exact: true }).waitFor();
  assert(
    calls.some(
      (call) => call.path === '/api/settings/assistant' && call.method === 'PUT' && !Object.hasOwn(call.body, 'apiKey')
    )
  );
  await page
    .getByRole('button', {
      name: 'Test saved model · may incur cost',
      exact: true
    })
    .click();
  await page.getByText('Synthetic model test passed', { exact: true }).waitFor();
  assert(calls.some((c) => c.path === '/api/settings/provider/test-model' && c.body.acknowledgeCost === true));
  await openSettingsSection('redbark', 'RedBark');
  await page.getByRole('button', { name: 'Register / reuse destination', exact: true }).click();
  await page
    .getByRole('status')
    .filter({
      hasText: 'Thin-event notifications registered/reused: sync_run.succeeded and connection.refreshed'
    })
    .waitFor();
  await openSettingsSection('ai', 'AI features');
  await page.getByLabel('AI provider', { exact: true }).selectOption('bedrock');
  await page.getByLabel('AWS region', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('AWS secret access key', { exact: true }).inputValue(), '');
  await page.getByLabel('AWS region', { exact: true }).selectOption('ap-southeast-2');
  assert.equal(await page.getByLabel('Session token', { exact: false }).count(), 0);
  const discardDialog = page.waitForEvent('dialog').then(async (dialog) => {
    assert.match(dialog.message(), /unsaved changes.*discard the draft/);
    await dialog.accept();
  });
  await openSettingsSection('notifications', 'Notifications');
  await discardDialog;
  const pairButton = page.getByRole('button', { name: 'Pair Telegram group', exact: true });
  const telegramEnabled = page.getByRole('checkbox', { name: 'Enable Telegram alerts to the confirmed group' });
  await expect(pairButton).toBeDisabled();
  await expect(telegramEnabled).toBeDisabled();
  await page.getByRole('checkbox', { name: 'Budget period', exact: true }).uncheck();
  await page.getByLabel('SMTP connection URL', { exact: true }).fill('smtps://synthetic:only@mail.example.com:465');
  await page.getByLabel('Telegram bot token', { exact: true }).fill(telegramToken);
  await expect(pairButton).toBeDisabled();
  await page.getByRole('checkbox', { name: /^I understand notifications can show/ }).check();
  await page.getByRole('button', { name: 'Save notification settings', exact: true }).click();
  await expect(page.getByLabel('SMTP connection URL', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Telegram bot token', { exact: true })).toHaveValue('');
  await expect(page.getByRole('checkbox', { name: 'Budget period', exact: true })).not.toBeChecked();
  assert(
    calls.some(
      (c) =>
        c.path === '/api/settings/notifications' &&
        c.method === 'PUT' &&
        !c.body.summaryFields.includes('period') &&
        c.body.smtp.smtpUrl === 'smtps://synthetic:only@mail.example.com:465' &&
        c.body.telegram.token === telegramToken &&
        c.body.telegram.enabled === false &&
        c.body.audienceConfirmed === true
    )
  );
  await pairButton.click();
  await expect(page.getByText('/pair@testbot synthetic-nonce', { exact: true })).toBeVisible();
  await expect(telegramEnabled).toBeDisabled();
  await page.getByRole('button', { name: 'Check for group', exact: true }).click();
  await page.getByText('Fictional household', { exact: true }).waitFor();
  await expect(telegramEnabled).toBeDisabled();
  await page
    .getByRole('button', {
      name: 'Confirm group and enable Telegram alerts',
      exact: true
    })
    .click();
  await page.getByText('Synthetic group confirmed', { exact: true }).waitFor();
  await expect(telegramEnabled).toBeEnabled();
  await expect(telegramEnabled).toBeChecked();
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
  assert(calls.some((c) => c.path === '/api/notifications/test' && c.method === 'POST' && c.body.channel === 'smtp'));
  await openSettingsSection('data', 'Data');
  await page.getByLabel('Account for history import', { exact: true }).selectOption('a1');
  await page.getByLabel('History from', { exact: true }).fill('2026-01-01');
  await page.getByRole('button', { name: 'Queue history import', exact: true }).click();
  assert.equal(calls.filter((c) => c.path === '/api/import-health/backfill').length, 0);
  await page.getByLabel('History to', { exact: true }).fill('2026-02-01');
  await page.getByRole('button', { name: 'Queue history import', exact: true }).click();
  await page.getByText('Synthetic history queued', { exact: true }).waitFor();
  const backfills = calls.filter((c) => c.path === '/api/import-health/backfill');
  assert.equal(backfills.length, 1);
  assert.equal(backfills[0].method, 'POST');
  assert.deepEqual(backfills[0].body, { accountId: 'a1', from: '2026-01-01', to: '2026-02-01' });
  assert.equal(await page.locator('body').evaluate((e) => e.scrollWidth <= innerWidth), true);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(250);
  assert.equal(
    await page.locator('body').evaluate((e) => e.scrollWidth <= innerWidth),
    true,
    'settings mobile overflow'
  );
  await page.screenshot({
    path: 'test-results/dolphino-settings-mobile.png',
    fullPage: true
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  await assertPageStorageUnused();
  console.log(
    'Enhancement browser checks passed: periods, edit/card scope, pagination/date reset, write-only credentials, synthetic model acknowledgment, webhook reuse, Bedrock region fields, SMTP settings/test, Telegram group confirmation, bounded backfill, desktop/mobile overflow. All API calls mocked.'
  );
} catch (error) {
  console.error('Enhancement browser diagnostics:', { url: page.url(), errors, external });
  throw error;
} finally {
  await browser.close();
  await server.close();
}
