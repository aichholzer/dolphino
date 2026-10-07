import { readTestPostgresConfig } from '../../backend/test/helpers/postgres.mjs';
import { installBrowserStorageGuard } from './browser-storage-guard.mjs';
import { createSimplefinIntegration } from '../../backend/src/lib/simplefin.mjs';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import pg from 'pg';
import { expect } from '@playwright/test';
import { chromium } from './browser.mjs';
import { Store } from '../../backend/src/lib/store.mjs';
import { createApp } from '../../backend/src/app.mjs';
import { ensureDeploymentMode } from '../../backend/src/lib/deployment-mode.mjs';
import { createHouseholdAuth } from '../../backend/src/lib/household-auth.mjs';
import { ensureAccessSchema, validateAndSetGrants } from '../../backend/src/lib/access.mjs';
import { createSettingsStore } from '../../backend/src/lib/settings.mjs';
import { createRedbarkSettings } from '../../backend/src/lib/redbark-settings.mjs';
import { createRedbarkIntegration } from '../../backend/src/lib/worker.mjs';
import { createRegistration } from '../../backend/src/lib/registration.mjs';
import { createClassificationIntegration } from '../../backend/src/lib/classification.mjs';
import { createAiSettings } from '../../backend/src/lib/ai-settings.mjs';
import { createNotificationIntegration } from '../../backend/src/lib/notifications.mjs';
import { createTelegramPairing } from '../../backend/src/lib/telegram.mjs';
import { createImportHealth } from '../../backend/src/lib/import-health.mjs';
import { createUserManagement } from '../../backend/src/lib/users.mjs';

// Real compiled frontend + HTTP createApp + isolated PostgreSQL schema. Only
// outbound provider transports are injected. No /api response is intercepted.
const database = readTestPostgresConfig();
assert(
  database,
  'Set PGHOST, PGDATABASE, PGUSER (or TEST_DATABASE_URL) for a disposable PostgreSQL database; see docs/testing.md.'
);
const owner = new pg.Pool(database);
const schema = `browser_settings_${randomUUID().replaceAll('-', '')}`;
await owner.query(`CREATE SCHEMA ${schema}`);
const pool = new pg.Pool({
  ...database,
  options: `-c search_path=${schema}`
});
const errors = [];
let server, browser, base;
const forbiddenOutbound = async () => {
  throw Error('Unexpected outbound provider operation in isolated browser fixture');
};

const config = {
  mode: 'live',
  host: '127.0.0.1',
  port: 0,
  origin: 'https://synthetic.invalid',
  currency: 'AUD',
  timezone: 'Australia/Brisbane',
  bootstrapToken: randomBytes(32).toString('base64'),
  appSecret: randomBytes(32).toString('base64')
};
const screenshots = process.env.DOLPHINO_SCREENSHOT_DIR || 'artifacts';
try {
  await ensureDeploymentMode(pool, 'live');
  const store = new Store(pool, { mode: 'live', timezone: config.timezone });
  await store.migrate();
  const vault = createSettingsStore({ pool, appSecret: config.appSecret });
  const aiSettings = createAiSettings({ pool, settings: vault, appSecret: config.appSecret });
  await aiSettings.init();
  const settings = { ...vault, ...aiSettings.classification };
  await settings.init();
  const redbarkSettings = createRedbarkSettings({
    pool,
    settings,
    appSecret: config.appSecret
  });
  const integration = createRedbarkIntegration({
    pool,
    store,
    config,
    getRedbarkConfig: redbarkSettings.getRuntimeConfig,
    fetchImpl: async (url) => {
      assert.equal(new URL(url).pathname, '/v2/accounts');
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }
  });
  await integration.init();
  const registration = createRegistration({
    pool,
    settings,
    config,
    getRedbarkConfig: redbarkSettings.getRuntimeConfig,
    client: { request: forbiddenOutbound },
    lookupImpl: forbiddenOutbound
  });
  await registration.init();
  const classification = createClassificationIntegration({
    pool,
    store,
    config,
    getProviderConfig: settings.getProviderConfig,
    fetchImpl: forbiddenOutbound
  });
  await classification.init();
  const assistantSettings = aiSettings.assistant;
  const notifications = createNotificationIntegration({
    pool,
    settings,
    mode: 'live',
    sendTelegram: forbiddenOutbound,
    sendSmtpImpl: forbiddenOutbound
  });
  await notifications.init();
  const telegram = createTelegramPairing({
    pool,
    settings,
    fetchImpl: forbiddenOutbound
  });
  await telegram.init();
  const importHealth = createImportHealth({ pool, store, config, integration });
  const auth = createHouseholdAuth({ pool, config });
  await auth.init();
  await ensureAccessSchema(pool);
  const users = createUserManagement({
    pool,
    config,
    settings,
    sendMail: forbiddenOutbound
  });
  await users.init();
  const admin = await auth.bootstrap(
    { headers: {}, socket: { remoteAddress: 'synthetic-browser-fixture' } },
    {
      email: 'synthetic-admin@example.com',
      name: 'Synthetic admin',
      password: 'synthetic browser password',
      bootstrapToken: config.bootstrapToken
    }
  );
  const memberId = (
    await pool.query(
      "INSERT INTO household_users(email,name,role,password_hash) SELECT 'synthetic-member@example.com','Synthetic member','member',password_hash FROM household_users WHERE id=$1 RETURNING id",
      [admin.user.id]
    )
  ).rows[0].id;
  await auth.login(
    { headers: {}, socket: { remoteAddress: 'synthetic-browser-fixture' } },
    {
      email: 'synthetic-member@example.com',
      password: 'synthetic browser password'
    }
  );
  await store.ingest({
    sourceId: 'synthetic-browser-transaction',
    accountId: 'synthetic-browser-account',
    currency: 'AUD',
    amountMinor: '-100',
    date: new Date().toISOString().slice(0, 10),
    status: 'posted',
    kind: 'expense',
    category: 'Uncategorized',
    description: 'Synthetic browser grocery purchase'
  });
  await store.atomic(
    (client) =>
      validateAndSetGrants(
        client,
        memberId,
        {
          accounts: [{ accountId: 'synthetic-browser-account', access: 'view' }]
        },
        { mode: 'live' }
      ),
    { refresh: false }
  );
  let claimCount = 0;
  const simplefin = createSimplefinIntegration({
    pool,
    store,
    settings,
    config,
    request: async (url, options) => {
      if (options?.method === 'POST') {
        claimCount++;
        return {
          status: 200,
          body: 'https://synthetic-user:synthetic-simplefin-secret@provider.example.com/simplefin'
        };
      }

      return {
        status: 200,
        body: JSON.stringify({
          errors: [],
          accounts: [
            {
              id: 'fixture-bank',
              name: 'Fictional SimpleFIN checking',
              org: { domain: 'bank.example.com', name: 'Fictional bank' },
              currency: 'AUD',
              balance: '123.45',
              'balance-date': Math.floor(Date.now() / 1000),
              transactions: url.searchParams.has('balances-only')
                ? []
                : [
                    {
                      id: 'fixture-transaction',
                      posted: Math.floor(Date.now() / 1000) - 3600,
                      amount: '-12.34',
                      description: 'Fictional SimpleFIN purchase'
                    }
                  ]
            }
          ]
        })
      };
    }
  });
  await simplefin.init();
  const app = createApp({
    simplefin,
    store,
    config,
    auth,
    users,
    settings,
    redbarkSettings,
    integration,
    registration,
    classification,
    assistantSettings,
    aiSettings,
    notifications,
    telegram,
    importHealth,
    providerDependencies: {
      fetchImpl: async (url) => {
        assert.equal(new URL(url).origin, 'https://api.openai.com');
        return new Response(JSON.stringify({ id: 'synthetic-model' }), {
          status: 200
        });
      }
    }
  });
  server = await new Promise((resolve) => {
    const started = app.start(() => resolve(started));
  });
  base = `http://127.0.0.1:${server.address().port}`;
  config.origin = base; // Real browser Origin/CSRF checks use the dynamic local test origin.
  const adminCookie = admin.cookie.split(';')[0];
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
    args: ['--no-sandbox']
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 }
  });
  await context.addCookies([
    {
      name: 'dolphino_session',
      value: adminCookie.split('=')[1],
      url: base,
      httpOnly: true,
      sameSite: 'Strict'
    }
  ]);
  await context.route('**/*', (route) =>
    new URL(route.request().url()).origin === base ? route.continue() : route.abort()
  );
  const page = await context.newPage();
  const assertPageStorageUnused = await installBrowserStorageGuard(page);
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('link', { name: /^Bank feeds/ }).click();
  await page.locator('.bank-feed-panel > summary').filter({ hasText: 'SimpleFIN' }).click();
  const section = page.getByRole('region', {
    name: 'SimpleFIN optional import'
  });
  await expect(section.getByText('Not connected', { exact: true })).toBeVisible();
  const setupToken = Buffer.from('https://provider.example.com/simplefin/claim/synthetic-browser-token').toString(
    'base64'
  );
  await expect(section.getByRole('button', { name: 'Connect SimpleFIN', exact: true })).toBeDisabled();
  await section.getByLabel('One-use setup token').fill(setupToken);
  await section.getByRole('button', { name: 'Connect SimpleFIN', exact: true }).click();
  await expect(section.getByText('Paused', { exact: true })).toBeVisible();
  assert.equal(claimCount, 1);
  assert(!(await page.content()).includes('synthetic-simplefin-secret'));
  assert(!(await page.content()).includes(setupToken));
  await section.getByRole('button', { name: 'Test and discover accounts', exact: true }).click();
  await expect(section.getByText('Fictional SimpleFIN checking', { exact: true })).toBeVisible();
  page.once('dialog', (dialog) => dialog.dismiss());
  await section.getByRole('button', { name: 'Map as a new account', exact: true }).click();
  assert.equal((await simplefin.status()).accounts[0].localId, null);
  page.once('dialog', (dialog) => dialog.accept());
  await section.getByRole('button', { name: 'Map as a new account', exact: true }).click();
  await expect(section.getByText(/Mapped to Dolphino/)).toBeVisible();
  await section.getByRole('checkbox', { name: 'Enable scheduled imports', exact: true }).check();
  await section.getByRole('button', { name: 'Save SimpleFIN settings', exact: true }).click();
  await expect(section.getByText('Enabled', { exact: true })).toBeVisible();
  await simplefin.tick();
  assert.equal(
    (await store.listTransactions()).filter((x) => x.description === 'Fictional SimpleFIN purchase').length,
    1
  );
  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('link', { name: /^Bank feeds/ }).click();
  await page.locator('.bank-feed-panel > summary').filter({ hasText: 'SimpleFIN' }).click();
  await expect(section.getByText('Enabled', { exact: true })).toBeVisible();
  await mkdir(screenshots, { recursive: true });
  await section.screenshot({
    path: `${screenshots}/dolphino-simplefin-desktop.png`,
    animations: 'disabled'
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() => page.locator('.sidebar').evaluate((el) => el.getBoundingClientRect().right))
    .toBeLessThanOrEqual(0);
  await section.scrollIntoViewIfNeeded();
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await section.screenshot({
    path: `${screenshots}/dolphino-simplefin-mobile.png`,
    animations: 'disabled'
  });
  await section.getByRole('checkbox', { name: 'Enable scheduled imports', exact: true }).uncheck();
  await section.getByRole('button', { name: 'Save SimpleFIN settings', exact: true }).click();
  await expect(section.getByText('Paused', { exact: true })).toBeVisible();
  const before = claimCount;
  await simplefin.tick();
  assert.equal(claimCount, before);
  page.once('dialog', (dialog) => dialog.dismiss());
  await section.getByRole('button', { name: 'Disconnect locally', exact: true }).click();
  assert.equal((await simplefin.status()).configured, true);
  page.once('dialog', (dialog) => dialog.accept());
  await section.getByRole('button', { name: 'Disconnect locally', exact: true }).click();
  await expect(section.getByText('Not connected', { exact: true })).toBeVisible();
  assert.equal(
    (await store.listTransactions()).filter((x) => x.description === 'Fictional SimpleFIN purchase').length,
    1
  );
  assert.equal(await settings.getSecret('simplefin.accessUrl', 'simplefin'), null);
  assert.deepEqual(errors, []);
  await assertPageStorageUnused();
  console.log(
    'PASS Real HTTP + PostgreSQL + real household session browser: one-use claim, masked credentials, discover, cancel/confirm mapping, enable, actual import, reload, desktop/mobile fit, pause, cancel/confirm local disconnect and retained history. No API mocking or external provider calls.'
  );
} finally {
  await browser?.close();
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }

  await pool.end();
  await owner.query(`DROP SCHEMA ${schema} CASCADE`);
  await owner.end();
}
