import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { installBrowserStorageGuard } from '../frontend/test/browser-storage-guard.mjs';

// Run after npm run build, against the disposable app served by with-demo.sh.
// Static assets are the real compiled frontend; every API is a synthetic fixture.
// No provider, real credentials, deployment database, or browser storage is used.
const base = process.env.DOLPHINO_TEST_URL || 'http://127.0.0.1:3001';
assert(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname), 'Use a local test application');
const output = resolve(process.env.DOLPHINO_SCREENSHOT_DIR || '/tmp/dolphino-category-repair-evidence');
const repo = resolve(new URL('..', import.meta.url).pathname);
assert(!output.startsWith(repo + '/'), 'Keep synthetic screenshot evidence outside the repository');
const build = /src="\/assets\/([^"]+)"/.exec(
  await readFile(new URL('../frontend/dist/index.html', import.meta.url), 'utf8')
)?.[1];
assert(build, 'Build the frontend before running this compiled-UI regression');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
  args: ['--no-sandbox']
});
const evidence = [];
const opaque = 'cat_legacy_unresolved';
const splitOpaque = 'cat_split_unresolved';
const account = { id: 'acct_synthetic', name: 'Synthetic checking', currency: 'AUD', balanceMinor: '100000' };
const admin = {
  authenticated: true,
  demo: false,
  user: { id: 'synthetic-admin', name: 'Synthetic admin', role: 'admin' },
  currency: 'AUD',
  timeZone: 'UTC',
  permissions: { accessRevision: '1', accountAccess: true }
};
const initialTransactions = [
  {
    id: 'tx_unresolved',
    accountId: account.id,
    accountName: account.name,
    description: 'Synthetic unresolved purchase',
    date: '2026-10-01',
    amountMinor: '-2500',
    currency: 'AUD',
    status: 'posted',
    kind: 'expense',
    category: opaque,
    categoryDisplayLabel: 'Unresolved category',
    notes: 'Keep this manual note',
    splits: []
  },
  {
    id: 'tx_named',
    accountId: account.id,
    accountName: account.name,
    description: 'Synthetic named purchase',
    date: '2026-10-01',
    amountMinor: '-1200',
    currency: 'AUD',
    status: 'posted',
    kind: 'expense',
    category: 'Groceries',
    notes: 'Keep the named category note',
    splits: []
  },
  {
    id: 'tx_split',
    accountId: account.id,
    accountName: account.name,
    description: 'Synthetic manual split',
    date: '2026-10-01',
    amountMinor: '-3000',
    currency: 'AUD',
    status: 'posted',
    kind: 'expense',
    category: 'Custom household',
    notes: 'Keep the split note',
    splits: [
      { category: splitOpaque, categoryDisplayLabel: 'Unresolved category', amountMinor: '-1000' },
      { category: 'Named manual split', amountMinor: '-2000' }
    ]
  }
];
const budget = {
  category: opaque,
  categoryDisplayLabel: 'Unresolved category',
  capMinor: '50000',
  allocationMinor: '3000',
  rolloverEnabled: true,
  rolloverMinor: '1000',
  spentMinor: '2500',
  availableMinor: '54000',
  remainingMinor: '51500',
  transactionIds: ['tx_unresolved']
};
const repairResult = {
  message: 'Category repair complete.',
  accounts: 3,
  updated: 4,
  unresolved: 2,
  manualReferencesUpdated: 0,
  manualReferencesPreserved: 5,
  budgetsNeedingReview: 2,
  rulesNeedingReview: 3,
  skipped: 1
};
function gate() {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

const repairs = (state) => state.calls.filter((call) => call.path === '/api/import-health/repair-categories');
const patches = (state) =>
  state.calls.filter((call) => call.path.startsWith('/api/transactions/') && call.method === 'PATCH');
async function settle(page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function navigate(page, name) {
  const button = page.getByRole('button', { name, exact: true });
  const menu = page.getByRole('button', { name: 'Open menu', exact: true });
  if ((await menu.isVisible()) && !(await page.locator('.sidebar-open').count())) {
    await menu.click();
  }

  await button.click();
}

// Category controls hold the stored key and show its display label.
async function expectUnresolved(select, key = opaque) {
  await expect(select).toHaveValue(key);
  await expect(select.locator('option:checked')).toHaveText('Unresolved category');
}

async function noOpaqueText(page) {
  const text = await page.locator('body').innerText();
  for (const key of [opaque, splitOpaque]) {
    assert(!text.includes(key), `The raw provider key ${key} must not be visible`);
  }

  const values = await page
    .locator('input:not([type="hidden"]), textarea')
    .evaluateAll((inputs) => inputs.map((input) => input.value));
  assert(
    !values.includes(opaque) && !values.includes(splitOpaque),
    'Editors must display the backend label, not opaque keys'
  );
  const options = await page.locator('select option').allTextContents();
  assert(
    options.every((label) => !label.includes(opaque) && !label.includes(splitOpaque)),
    'Visible filter options must not expose opaque keys'
  );
}

async function enterSettings(page) {
  await navigate(page, 'Settings');
  await page.getByRole('link', { name: /^Data/ }).click();
  await expect(
    page.locator('.import-health').getByRole('heading', { name: 'Import health & history', exact: true })
  ).toBeVisible();
}

async function screenshot(page, name, locator = page) {
  const path = `${output}/${name}.png`;
  await locator.screenshot({ path, animations: 'disabled', ...(locator === page ? { fullPage: false } : {}) });
  return path;
}

async function scenario(name, viewport, run, session = admin) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const state = {
    calls: [],
    external: [],
    errors: [],
    unknown: [],
    assets: [],
    gates: [],
    repairGate: null,
    repairError: null,
    warning: 'category_lookup_forbidden',
    transactions: structuredClone(initialTransactions),
    session: structuredClone(session)
  };
  const assertNoStorage = await installBrowserStorageGuard(page);
  page.on('pageerror', (error) => state.errors.push(error.message));
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/assets/')) {
      state.assets.push(url.pathname);
    }
  });
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== new URL(base).origin) {
      state.external.push(request.url());
      await route.abort();
      return;
    }

    if (!url.pathname.startsWith('/api/')) {
      await route.continue();
      return;
    }

    const call = { path: url.pathname, query: url.search, method: request.method(), body: request.postDataJSON() };
    state.calls.push(call);
    let data;
    if (call.path === '/api/session') {
      data = state.session;
    } else if (call.path === '/api/dashboard') {
      data = {
        incomeMinor: '0',
        expensesMinor: '6700',
        netMinor: '-6700',
        pendingMinor: '0',
        startDate: '2026-10-01',
        endDate: '2026-10-31',
        categories: [
          {
            category: opaque,
            categoryDisplayLabel: 'Unresolved category',
            amountMinor: '2500',
            transactionIds: ['tx_unresolved']
          },
          { category: 'Groceries', amountMinor: '1200', transactionIds: ['tx_named'] }
        ]
      };
    } else if (call.path === '/api/transactions') {
      data = { transactions: state.transactions, total: state.transactions.length, hasMore: false };
    } else if (call.path.startsWith('/api/transactions/') && call.method === 'PATCH') {
      const transaction = state.transactions.find((item) => item.id === call.path.split('/').at(-1));
      Object.assign(transaction, structuredClone(call.body));
      // Model the backend display metadata without ever changing the stored key.
      for (const split of transaction.splits || []) {
        if (split.category === splitOpaque) {
          split.categoryDisplayLabel = 'Unresolved category';
        }
      }

      if (Object.hasOwn(call.body, 'category')) {
        delete transaction.categoryDisplayLabel;
      }

      data = { message: 'Synthetic correction saved' };
    } else if (call.path === '/api/accounts') {
      data = { accounts: [account] };
    } else if (call.path === '/api/budgets') {
      data = call.method === 'PUT' ? { message: 'Synthetic budget saved' } : { budgets: [budget], alerts: [] };
    } else if (call.path === '/api/reviews') {
      data = { reviews: [{ ...initialTransactions[0], reviewReason: 'Synthetic category needs review' }] };
    } else if (call.path === '/api/rules') {
      data = {
        rules: [
          {
            id: 'rule_synthetic',
            match: 'Synthetic merchant',
            category: opaque,
            categoryDisplayLabel: 'Unresolved category',
            kind: 'expense'
          }
        ]
      };
    } else if (call.path === '/api/settings') {
      data = { llm: { enabled: false }, redbark: { configured: true } };
    } else if (call.path === '/api/settings/redbark') {
      data = { version: '2026-10-01.wattle', backfillDays: 90, encryptionAvailable: false, credentials: {} };
    } else if (['/api/settings/provider', '/api/settings/assistant'].includes(call.path)) {
      data = { provider: 'openai', enabled: false, credentials: {}, encryptionAvailable: false };
    } else if (call.path === '/api/settings/simplefin') {
      data = { backfillDays: 30, enabled: false, accounts: [] };
    } else if (call.path === '/api/settings/pocketsmith') {
      data = { configured: false, enabled: false, backfillDays: 90, accounts: [] };
    } else if (call.path === '/api/settings/deleted-accounts') {
      data = { accounts: [] };
    } else if (call.path === '/api/categories') {
      data = {
        catalog: ['Groceries', 'Named correction', 'Deliberate manual correction', 'Unsaved navigation edit'].map(
          (name) => ({ category: name, name, archived: false })
        )
      };
    } else if (call.path === '/api/tags') {
      data = { tags: [] };
    } else if (call.path === '/api/users') {
      data = { users: [], invitations: [] };
    } else if (call.path === '/api/users/grant-options') {
      data = { accounts: [], budgets: [] };
    } else if (call.path === '/api/notifications/deliveries') {
      data = [];
    } else if (
      ['/api/settings/webhook', '/api/settings/notifications', '/api/settings/telegram/pair'].includes(call.path)
    ) {
      data = {};
    } else if (call.path === '/api/import-health') {
      data = {
        integration: { categoryWarning: state.warning },
        accounts: [{ ...account, postedCount: 3, pendingCount: 0, importSource: 'redbark' }],
        jobs: [
          {
            id: 'job_synthetic',
            type: 'transactions',
            status: 'failed',
            attempts: 1,
            lastError: 'Synthetic retryable error'
          }
        ]
      };
    } else if (call.path === '/api/import-health/repair-categories') {
      const pending = state.repairGate;
      if (pending) {
        await pending.promise;
      }

      if (state.repairError) {
        await route.fulfill({ status: 503, json: { error: state.repairError } });
        return;
      }

      data = repairResult;
    } else {
      state.unknown.push(call);
      await route.fulfill({ status: 501, json: { error: 'Unexpected synthetic test API' } });
      return;
    }

    await route.fulfill({ json: data });
  });
  let result;
  try {
    await page.goto(base);
    await expect(page.getByText('Total income', { exact: true })).toBeVisible();
    assert(state.assets.includes(`/assets/${build}`), 'The browser must load the current compiled frontend');
    result = await run(page, state);
    await assertNoStorage();
    assert.deepEqual(state.errors, [], 'No uncaught browser errors');
    assert.deepEqual(state.external, [], 'No external browser calls');
    assert.deepEqual(state.unknown, [], 'All API calls remain within the explicit synthetic fixture');
    evidence.push({ name, result: 'passed', screenshots: result || [], requests: state.calls });
    console.log(`PASS ${name}`);
  } catch (error) {
    const failure = await screenshot(page, `${name}-failure`).catch(() => null);
    evidence.push({ name, result: 'failed', error: error.message, screenshot: failure, requests: state.calls });
    throw error;
  } finally {
    for (const pending of state.gates) {
      pending.release();
    }

    await writeFile(
      `${output}/evidence.json`,
      JSON.stringify(
        { build, compiledFrontend: true, mockedApiResponses: true, providerCalls: false, cases: evidence },
        null,
        2
      ) + '\n'
    );
    await context.close();
  }
}

try {
  for (const [size, viewport] of [
    ['desktop', { width: 1440, height: 1000 }],
    ['mobile', { width: 390, height: 844 }]
  ]) {
    await scenario(`repair-${size}`, viewport, async (page, state) => {
      await enterSettings(page);
      const health = page.locator('.import-health');
      await expect(health).toContainText('categories:read');
      await expect(health).toContainText('Bank imports continue');
      const button = health.getByRole('button', { name: 'Repair category names', exact: true });
      const pending = gate();
      state.gates.push(pending);
      state.repairGate = pending;
      // Two synchronous clicks exercise the ref guard before React can repaint.
      await button.evaluate((element) => {
        element.click();
        element.click();
      });
      await expect.poll(() => repairs(state).length).toBe(1);
      await expect(button).toBeDisabled();
      await expect(health.getByRole('button', { name: 'Refresh import status', exact: true })).toBeDisabled();
      await expect(health.getByRole('button', { name: 'Queue history import', exact: true })).toBeDisabled();
      await expect(health.getByRole('button', { name: 'Retry job job_synthetic', exact: true })).toBeDisabled();
      assert.equal(repairs(state)[0].method, 'POST');
      assert.deepEqual(repairs(state)[0].body, {}, 'Repair submits an empty, bounded operation body');
      await button.evaluate((element) => element.click());
      await settle(page);
      assert.equal(repairs(state).length, 1, 'Busy clicks cannot start another repair');
      const files = [await screenshot(page, `repair-${size}-busy`, health)];
      pending.release();
      state.repairGate = null;
      await expect(button).toBeEnabled();
      const notice = health.locator('.alert-success');
      await expect(notice).toContainText('Accounts checked: 3');
      await expect(notice).toContainText('Category labels updated: 4');
      await expect(notice).toContainText('Still unresolved: 2');
      await expect(notice).toContainText('Accounts skipped: 1');
      await expect(notice).toContainText(/(?:saved category references|manual references).*?(?:review|preserv)/i);
      await expect(notice).toContainText('5');
      await expect(notice).toContainText('Budgets to review: 2');
      await expect(notice).toContainText('Rules to review: 3');
      assert(
        !/Saved references updated: [1-9]/.test(await notice.innerText()),
        'Ambiguous manual references must not be reported as rewritten'
      );
      await expect.poll(() => state.calls.filter((call) => call.path === '/api/import-health').length).toBe(2);
      files.push(await screenshot(page, `repair-${size}-result`, health));
      state.repairError = 'Synthetic taxonomy temporarily unavailable';
      await button.click();
      await expect(health.getByRole('alert')).toHaveText(state.repairError);
      await expect(button).toBeEnabled();
      await expect(health.locator('.alert-success')).toHaveCount(0);
      state.repairError = null;
      await button.click();
      await expect(notice).toContainText('Category repair complete');
      await expect(health.getByRole('alert')).toHaveCount(0);
      assert.equal(repairs(state).length, 3, 'Failed repair permits exactly one explicit retry');
      assert.equal(
        await page.locator('body').evaluate((body) => body.scrollWidth <= innerWidth),
        true,
        'Responsive repair view has no page overflow'
      );
      return files;
    });

    await scenario(`category-keys-${size}`, viewport, async (page, state) => {
      await noOpaqueText(page);
      await page.locator('.category-row').filter({ hasText: 'Unresolved category' }).click();
      const filter = page.getByLabel('Filter category', { exact: true });
      await expect(filter).toHaveValue(opaque);
      await expect(filter.locator('option:checked')).toHaveText('Unresolved category');
      await expect
        .poll(() =>
          state.calls.some(
            (call) => call.path === '/api/transactions' && new URLSearchParams(call.query).get('category') === opaque
          )
        )
        .toBe(true);
      const exported = new URL(
        await page.getByRole('link', { name: 'Export', exact: true }).getAttribute('href'),
        base
      );
      assert.equal(exported.searchParams.get('category'), opaque, 'Export retains the raw category key');
      await noOpaqueText(page);
      await expect(page.locator('.category-tag').filter({ hasText: /^Groceries$/ })).toHaveCount(1);
      const files = [await screenshot(page, `categories-${size}`)];
      await page.getByRole('button', { name: 'Edit Synthetic unresolved purchase', exact: true }).click();
      const dialog = page.getByRole('dialog');
      await expectUnresolved(dialog.getByLabel('Category', { exact: true }));
      await expect(dialog).toContainText('Leaving it unchanged preserves its saved category');
      await noOpaqueText(page);
      files.push(await screenshot(page, `transaction-${size}-unresolved`, dialog));
      await dialog.getByRole('button', { name: 'Save correction', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      assert.equal(patches(state).length, 1);
      assert(
        !Object.hasOwn(patches(state)[0].body, 'category'),
        'Untouched category must be omitted, never sent as a placeholder or opaque manual override'
      );
      assert(!Object.hasOwn(patches(state)[0].body, 'notes'), 'A category correction must not replace existing notes');
      await page.getByRole('button', { name: 'Edit Synthetic unresolved purchase', exact: true }).click();
      await dialog.getByLabel('Transaction type').selectOption('transfer');
      await dialog.getByRole('button', { name: 'Save correction', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      assert.equal(patches(state).at(-1).body.kind, 'transfer');
      assert(
        !Object.hasOwn(patches(state).at(-1).body, 'category'),
        'Kind-only changes cannot manufacture a manual category override'
      );
      await page.getByRole('button', { name: 'Edit Synthetic manual split', exact: true }).click();
      await expectUnresolved(dialog.getByLabel('Split 1 category', { exact: true }), splitOpaque);
      await expect(dialog.getByLabel('Split 2 category', { exact: true })).toHaveValue('Named manual split');
      await expect(dialog.getByLabel('Split 1 amount', { exact: true })).toHaveValue('-10.00');
      await expect(dialog.getByLabel('Split 2 amount', { exact: true })).toHaveValue('-20.00');
      await noOpaqueText(page);
      await dialog.getByRole('button', { name: 'Save correction', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      assert(!Object.hasOwn(patches(state).at(-1).body, 'splits'), 'Untouched manual splits must be omitted');
      assert(!Object.hasOwn(patches(state).at(-1).body, 'kind'), 'Untouched manual kind must be omitted');
      await page.getByRole('button', { name: 'Edit Synthetic manual split', exact: true }).click();
      await dialog.getByLabel('Split 1 amount', { exact: true }).fill('-9.00');
      await dialog.getByLabel('Split 2 amount', { exact: true }).fill('-21.00');
      await dialog.getByRole('button', { name: 'Save correction', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      assert.deepEqual(
        patches(state).at(-1).body.splits,
        [
          { category: splitOpaque, amountMinor: '-900' },
          { category: 'Named manual split', amountMinor: '-2100' }
        ],
        'Amount-only split edits preserve both raw category keys and manual names'
      );
      assert(!Object.hasOwn(patches(state).at(-1).body, 'kind'));
      assert(!Object.hasOwn(patches(state).at(-1).body, 'category'));
      assert(!Object.hasOwn(patches(state).at(-1).body, 'notes'));
      await page.getByRole('button', { name: 'Edit Synthetic named purchase', exact: true }).click();
      await expect(dialog.getByLabel('Category', { exact: true })).toHaveValue('Groceries');
      await dialog.getByLabel('Category', { exact: true }).selectOption('Named correction');
      const beforeCancel = patches(state).length;
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      assert.equal(patches(state).length, beforeCancel, 'Cancel never submits a correction');
      await page.getByRole('button', { name: 'Edit Synthetic named purchase', exact: true }).click();
      await expect(dialog.getByLabel('Category', { exact: true })).toHaveValue('Groceries');
      await dialog.getByRole('button', { name: 'Close', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await page.getByRole('button', { name: 'Edit Synthetic unresolved purchase', exact: true }).click();
      await dialog.getByLabel('Category', { exact: true }).selectOption('Deliberate manual correction');
      await dialog.getByRole('button', { name: 'Save correction', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      assert.equal(patches(state).at(-1).body.category, 'Deliberate manual correction');
      await navigate(page, 'Budgets');
      await expect(
        page.locator('.budget-card').getByRole('heading', { name: 'Unresolved category', exact: true })
      ).toBeVisible();
      await noOpaqueText(page);
      await page.locator('.budget-card').getByRole('button', { name: 'Edit', exact: true }).click();
      await expectUnresolved(dialog.getByLabel('Category', { exact: true }));
      await dialog.getByLabel('Monthly cap', { exact: true }).fill('600.00');
      await dialog.getByRole('button', { name: 'Save budget', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      const savedBudget = state.calls.findLast((call) => call.path === '/api/budgets' && call.method === 'PUT');
      assert.equal(savedBudget.body.category, opaque, 'Saving a budget preserves its raw identity key');
      assert.equal(savedBudget.body.capMinor, '60000');
      assert.equal(savedBudget.body.allocationMinor, '3000');
      assert.equal(savedBudget.body.rolloverEnabled, true);
      await page.getByRole('button', { name: 'View spending', exact: true }).click();
      await expect(filter).toHaveValue(opaque);
      await expect(filter.locator('option:checked')).toHaveText('Unresolved category');
      await noOpaqueText(page);
      await navigate(page, 'Review');
      await expect(page.locator('.review-row')).toContainText('Unresolved category');
      await noOpaqueText(page);
      await page.getByRole('button', { name: 'Review details', exact: true }).click();
      await expectUnresolved(dialog.getByLabel('Category', { exact: true }));
      await dialog.getByRole('button', { name: 'Close', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await navigate(page, 'Rules');
      await expect(page.locator('.rule-row')).toContainText('Classify as Unresolved category');
      await noOpaqueText(page);
      return files;
    });
  }

  await scenario('repair-navigation-late-response', { width: 1440, height: 1000 }, async (page, state) => {
    await enterSettings(page);
    const pending = gate();
    state.repairGate = pending;
    state.gates.push(pending);
    await page.getByRole('button', { name: 'Repair category names', exact: true }).click();
    await expect.poll(() => repairs(state).length).toBe(1);
    page.once('dialog', (dialog) => dialog.accept());
    await navigate(page, 'Transactions');
    await expect(page.getByRole('button', { name: 'Edit Synthetic unresolved purchase', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Edit Synthetic unresolved purchase', exact: true }).click();
    await page.getByRole('dialog').getByLabel('Category', { exact: true }).selectOption('Unsaved navigation edit');
    await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await enterSettings(page);
    const reloads = state.calls.filter((call) => call.path === '/api/import-health').length;
    pending.release();
    state.repairGate = null;
    await settle(page);
    await expect(page.locator('.import-health .alert-success')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Repair category names', exact: true })).toBeEnabled();
    assert.equal(repairs(state).length, 1, 'Navigation and return do not retry pending work');
    await page.getByRole('button', { name: 'Refresh import status', exact: true }).click();
    await expect
      .poll(() => state.calls.filter((call) => call.path === '/api/import-health').length)
      .toBeGreaterThan(reloads);
    await navigate(page, 'Transactions');
    await page.getByRole('button', { name: 'Edit Synthetic unresolved purchase', exact: true }).click();
    await expectUnresolved(page.getByRole('dialog').getByLabel('Category', { exact: true }));
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    assert.equal(patches(state).length, 0, 'Closed edits remain unsubmitted when a late repair finishes');
    await noOpaqueText(page);
    return [await screenshot(page, 'repair-navigation-return')];
  });

  await scenario(
    'demo-repair-disabled',
    { width: 390, height: 844 },
    async (page, state) => {
      await enterSettings(page);
      const health = page.locator('.import-health');
      const button = health.getByRole('button', { name: 'Repair category names', exact: true });
      await expect(button).toBeDisabled();
      await button.evaluate((element) => element.click());
      await settle(page);
      assert.equal(repairs(state).length, 0, 'Demo cannot call the repair API');
      assert(
        state.calls.every((call) => call.method === 'GET'),
        'Demo test performs no external or mutation operations'
      );
      await expect(health).toContainText('unavailable in demo mode');
      return [await screenshot(page, 'repair-demo-disabled', health)];
    },
    { ...admin, demo: true }
  );

  await scenario(
    'member-repair-hidden',
    { width: 390, height: 844 },
    async (page, state) => {
      await page.getByRole('button', { name: 'Open menu', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Settings', exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Repair category names', exact: true })).toHaveCount(0);
      await navigate(page, 'Transactions');
      await page.getByRole('button', { name: 'Ask your administrator to import more history', exact: true }).click();
      await expect(page.getByText('Total income', { exact: true })).toBeVisible();
      assert(
        state.calls.every(
          (call) => !call.path.startsWith('/api/import-health') && !call.path.startsWith('/api/settings')
        ),
        'Member navigation cannot load administrator import/settings APIs'
      );
      await noOpaqueText(page);
      return [await screenshot(page, 'repair-member-hidden')];
    },
    {
      ...admin,
      user: { id: 'synthetic-member', name: 'Synthetic member', role: 'member' },
      permissions: { accounts: [{ accountId: account.id, access: 'view' }] }
    }
  );
} finally {
  await browser.close();
}

console.log(`Category repair compiled-UI regressions passed. Synthetic evidence: ${output}`);
