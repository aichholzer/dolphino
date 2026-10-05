import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { createCompiledServer as createServer } from './compiled-server.mjs';
import { installBrowserStorageGuard } from './browser-storage-guard.mjs';

// Own the loopback compiled server and intercept every API request. These synthetic
// fixtures never use a database, provider, credentials, or an existing session.
const root = fileURLToPath(new URL('..', import.meta.url));
const artifacts = fileURLToPath(new URL('../../artifacts/', import.meta.url));
const cases = [
  { id: 'negative', amountMinor: '-12345', currency: 'AUD', kind: 'expense', amount: '−$123.45' },
  { id: 'positive', amountMinor: '234567', currency: 'USD', kind: 'income', amount: 'USD 2,345.67' },
  { id: 'refund', amountMinor: '1234', currency: 'EUR', kind: 'refund', amount: 'EUR 12.34' },
  { id: 'transfer', amountMinor: '-7654', currency: 'JPY', kind: 'transfer', amount: '−JPY 7,654' },
  { id: 'three-decimals', amountMinor: '1234567', currency: 'KWD', kind: 'income', amount: 'KWD 1,234.567' },
  { id: 'zero', amountMinor: '0', currency: 'AUD', kind: 'refund', amount: '$0.00' },
  {
    id: 'large-positive',
    amountMinor: '9007199254740993',
    currency: 'AUD',
    kind: 'income',
    amount: '$90,071,992,547,409.93'
  },
  {
    id: 'large-negative',
    amountMinor: '-900719925474099312345',
    currency: 'AUD',
    kind: 'expense',
    amount: '−$9,007,199,254,740,993,123.45'
  },
  { id: 'null-amount', amountMinor: null, currency: 'USD', kind: 'expense', amount: '—' },
  { id: 'missing-amount', currency: 'AUD', kind: 'transfer', amount: '—' }
];
const reviews = cases.map(({ amount: _amount, ...values }) => ({
  ...values,
  description: `Synthetic ${values.id} review`,
  date: '2026-09-29T18:23:45.000Z',
  accountId: 'synthetic-account',
  accountName: 'Synthetic everyday account',
  category: values.kind === 'income' ? 'Salary' : 'Groceries',
  reviewReason: 'Check the synthetic original evidence.'
}));
const session = {
  authenticated: true,
  demo: false,
  user: { id: 'synthetic-admin', name: 'Synthetic administrator', role: 'admin' },
  currency: 'AUD',
  timeZone: 'UTC'
};
const server = await createServer({
  root,
  configFile: fileURLToPath(new URL('../vite.config.mjs', import.meta.url)),
  server: { host: '127.0.0.1', port: 0, strictPort: true },
  plugins: [
    {
      name: 'review-import-health-test-harness',
      configureServer(vite) {
        vite.middlewares.use('/test-import-health', async (_request, response) => {
          const html = await vite.transformIndexHtml(
            '/test-import-health',
            `<!doctype html>
            <html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
            <body><main><div id="root"></div></main><script type="module">
            import React from 'react';
            import { createRoot } from 'react-dom/client';
            import { ImportHealth } from '/src/components/import-health.jsx';
            import { api } from '/src/lib/api.mjs';
            import '/src/style.css';
            createRoot(document.getElementById('root')).render(
              React.createElement(ImportHealth, { api, demo: false })
            );
            </script></body></html>`
          );
          response.setHeader('Content-Type', 'text/html');
          response.end(html);
        });
      }
    }
  ]
});
let browser;
let base;

async function fixturePage() {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const state = {
    calls: [],
    pageErrors: [],
    consoleErrors: [],
    unexpectedRequests: [],
    // This is the server's public result of a synthetic categories:read 403.
    categoryWarning: 'category_lookup_forbidden',
    jobs: []
  };
  const assertNoStorageAccess = await installBrowserStorageGuard(page);
  page.on('pageerror', (error) => state.pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') {
      state.consoleErrors.push(message.text());
    }
  });
  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== base) {
      state.unexpectedRequests.push(request.url());
      await route.abort();
      return;
    }

    if (!url.pathname.startsWith('/api/')) {
      await route.continue();
      return;
    }

    state.calls.push({ path: url.pathname, method: request.method() });
    let data;
    if (request.method() === 'GET' && url.pathname === '/api/session') {
      data = session;
    } else if (request.method() === 'GET' && url.pathname === '/api/dashboard') {
      data = { incomeMinor: '0', expensesMinor: '0', netMinor: '0' };
    } else if (request.method() === 'GET' && url.pathname === '/api/reviews') {
      data = { reviews };
    } else if (request.method() === 'GET' && url.pathname === '/api/categories') {
      data = { catalog: [{ category: 'Groceries', name: 'Groceries', archived: false }] };
    } else if (request.method() === 'GET' && url.pathname === '/api/tags') {
      data = { tags: [] };
    } else if (request.method() === 'GET' && url.pathname === '/api/settings') {
      data = { llm: { enabled: false } };
    } else if (request.method() === 'GET' && url.pathname === '/api/import-health') {
      data = { integration: { categoryWarning: state.categoryWarning }, accounts: [], jobs: state.jobs };
    } else {
      state.unexpectedRequests.push(`${request.method()} ${request.url()}`);
      await route.fulfill({ status: 500, json: { error: 'Unexpected synthetic test request' } });
      return;
    }

    await route.fulfill({ json: data });
  });
  state.assertClean = async () => {
    await assertNoStorageAccess();
    assert.deepEqual(state.pageErrors, [], 'No uncaught browser page errors');
    assert.deepEqual(state.consoleErrors, [], 'No browser console errors');
    assert.deepEqual(state.unexpectedRequests, [], 'No unmocked API or external network requests');
    assert.ok(
      state.calls.every((call) => call.method === 'GET'),
      'Reviewing or cancelling must not mutate data'
    );
  };

  return { page, state };
}

const typeFact = (kind) =>
  ({
    expense: 'Expense',
    income: 'Income',
    refund: 'Refund',
    transfer: 'Transfer, excluded from income and spending totals'
  })[kind];

function rowFor(page, review) {
  return page
    .locator('.review-row')
    .filter({ has: page.getByRole('heading', { name: review.description, exact: true }) });
}

async function assertReviewRows(page) {
  await expect(page.locator('.review-row')).toHaveCount(reviews.length);
  for (const [index, review] of reviews.entries()) {
    const row = rowFor(page, review);
    await expect(row.locator('.amount')).toHaveText(`${cases[index].amount} ${review.currency}`);
    await expect(row.locator('p').nth(0)).toHaveText(
      `${cases[index].amount} ${review.currency} · 2026-09-29 · ${review.accountName}`
    );
    await expect(row.getByRole('term')).toHaveText(['Type', 'Category', 'Reason', 'Transaction']);
    await expect(row.getByRole('definition')).toHaveText([
      typeFact(review.kind),
      review.category,
      review.reviewReason.charAt(0).toUpperCase() + review.reviewReason.slice(1),
      review.id
    ]);
  }
}

async function openDetails(page, index) {
  const review = reviews[index];
  await rowFor(page, review).getByRole('button', { name: 'Review details', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit transaction', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAccessibleDescription(`${review.description} · ${cases[index].amount}`);
  await expect(dialog.getByRole('combobox', { name: 'Transaction type', exact: true })).toHaveValue(review.kind);
  await expect(dialog.getByRole('combobox', { name: 'Category', exact: true })).toHaveValue(review.category);
  return dialog;
}

async function assertNoOverflow(page, label) {
  const sizes = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
    elements: [
      ...document.querySelectorAll('.review-row, .review-actions, .review-link, .dialog-content, .import-health')
    ]
      .filter((element) => element.getClientRects().length)
      .map((element) => ({
        className: element.className,
        left: element.getBoundingClientRect().left,
        right: element.getBoundingClientRect().right,
        width: element.clientWidth,
        scroll: element.scrollWidth
      }))
  }));
  assert.ok(sizes.document <= sizes.viewport + 1, `${label}: document overflows ${JSON.stringify(sizes)}`);
  assert.ok(sizes.body <= sizes.viewport + 1, `${label}: body overflows ${JSON.stringify(sizes)}`);
  for (const element of sizes.elements) {
    assert.ok(
      element.left >= -1 && element.right <= sizes.viewport + 1,
      `${label}: offscreen ${JSON.stringify(element)}`
    );
    assert.ok(element.scroll <= element.width + 1, `${label}: content overflows ${JSON.stringify(element)}`);
  }
}

try {
  await server.listen();
  base = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox']
  });
  await mkdir(artifacts, { recursive: true });
  {
    const { page, state } = await fixturePage();
    try {
      await page.goto(base);
      await page.getByRole('button', { name: 'Review', exact: true }).click();
      await assertReviewRows(page);
      await page.screenshot({ path: `${artifacts}review-browser-desktop.png`, fullPage: true });
      for (const [index, review] of reviews.entries()) {
        const dialog = await openDetails(page, index);
        await dialog
          .getByRole('combobox', { name: 'Transaction type', exact: true })
          .selectOption(review.kind === 'income' ? 'expense' : 'income');
        await dialog.getByRole('combobox', { name: 'Category', exact: true }).selectOption('Groceries');
        await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
        await expect(page.getByRole('dialog')).toHaveCount(0);
        await expect(rowFor(page, review).getByRole('definition').first()).toHaveText(typeFact(review.kind));
        const reopened = await openDetails(page, index);
        if (index % 2) {
          await page.keyboard.press('Escape');
        } else {
          await reopened.getByRole('button', { name: 'Close', exact: true }).click();
        }

        await expect(page.getByRole('dialog')).toHaveCount(0);
      }

      await page.getByRole('button', { name: 'Overview', exact: true }).click();
      await page.getByText('Total income', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Review', exact: true }).click();
      await assertReviewRows(page);
      console.log(
        'Passed exact signed amounts, five currencies, zero/missing values, original types, and cancelled/repeated details'
      );

      for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 844 });
        await assertReviewRows(page);
        await assertNoOverflow(page, `Review at ${width}px`);
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({ path: `${artifacts}review-browser-mobile-${width}.png`, fullPage: true });
        const dialog = await openDetails(page, 7);
        await assertNoOverflow(page, `Review details at ${width}px`);
        if (width === 390) {
          await page.screenshot({ path: `${artifacts}review-browser-mobile-details.png` });
        }

        await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
        await expect(page.getByRole('dialog')).toHaveCount(0);
        await assertNoOverflow(page, `Review after cancellation at ${width}px`);
      }

      await state.assertClean();
      console.log(
        'Passed 390px and 320px mobile layout, including details and cancellation; no browser errors or storage access'
      );
    } finally {
      await page.close();
    }
  }

  {
    const { page, state } = await fixturePage();
    try {
      await page.goto(`${base}/test-import-health`);
      const warning = page.getByRole('status').filter({ hasText: 'Redbark category names could not all be resolved.' });
      await expect(warning).toBeVisible();
      await expect(warning).toContainText('Known names and your corrections are retained');
      await expect(warning).toContainText('Bank imports continue.');
      await expect(warning).toContainText('unresolved categories show as Uncategorized');
      await expect(warning).toContainText('categories:read permission and access to the category taxonomy');
      await page.setViewportSize({ width: 390, height: 844 });
      await assertNoOverflow(page, 'Import health warning at 390px');
      await page.screenshot({ path: `${artifacts}review-browser-category-warning.png`, fullPage: true });
      for (const status of [429, 503]) {
        // Both temporary failures pause provider work and expose the same public
        // warning; the UI must not promise uninterrupted imports during backoff.
        state.categoryWarning = 'category_lookup_unavailable';
        state.jobs = [
          {
            id: `synthetic-taxonomy-${status}`,
            type: 'redbark.sync',
            status: 'queued',
            attempts: 1,
            lastError: `Synthetic categories request returned ${status}; provider retry deferred.`,
            availableAt: '2026-10-02T00:00:00.000Z'
          }
        ];
        const readsBeforeBackoff = state.calls.filter((call) => call.path === '/api/import-health').length;
        await page.getByRole('button', { name: 'Refresh import status', exact: true }).click();
        await expect
          .poll(() => state.calls.filter((call) => call.path === '/api/import-health').length)
          .toBe(readsBeforeBackoff + 1);
        await expect(warning).toBeVisible();
        await expect(warning).toContainText('Known names and your corrections are retained');
        await expect(warning).toContainText(
          'subject to provider backoff. Saved category references need an explicit category choice.'
        );
        await expect(warning).not.toContainText(/imports continue/i);
        await expect(warning).not.toContainText('categories:read permission');
        await expect(page.getByText(state.jobs[0].lastError, { exact: false })).toBeVisible();
        await assertNoOverflow(page, `Import health ${status} backoff at 390px`);
        await page.screenshot({ path: `${artifacts}review-browser-category-backoff-${status}.png`, fullPage: true });
      }

      state.categoryWarning = null;
      state.jobs = [];
      const initialReads = state.calls.filter((call) => call.path === '/api/import-health').length;
      await page.getByRole('button', { name: 'Refresh import status', exact: true }).click();
      await expect
        .poll(() => state.calls.filter((call) => call.path === '/api/import-health').length)
        .toBe(initialReads + 1);
      await expect(warning).toHaveCount(0);
      await expect(page.getByRole('heading', { name: 'Import health & history', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Refresh import status', exact: true }).click();
      await expect
        .poll(() => state.calls.filter((call) => call.path === '/api/import-health').length)
        .toBe(initialReads + 2);
      await expect(warning).toHaveCount(0);
      await state.assertClean();
      console.log(
        'Passed synthetic categories:read 403 guidance, 429/503 backoff copy, and resolved warnings across repeated refreshes'
      );
    } finally {
      await page.close();
    }
  }
} finally {
  await browser?.close();
  await server.close();
}

console.log('Review and import-health browser regressions passed using isolated synthetic fixtures.');
