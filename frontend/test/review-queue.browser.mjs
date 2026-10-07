import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import { chromium } from './browser.mjs';
import { createCompiledServer as createServer } from './compiled-server.mjs';
import { installBrowserStorageGuard } from './browser-storage-guard.mjs';

// Review queue hardening: bulk resolution, keyboard flow, the pending match picker and
// view-only rows. Every API request is intercepted; fixtures are synthetic.
const root = fileURLToPath(new URL('..', import.meta.url));
const server = await createServer({
  root,
  configFile: fileURLToPath(new URL('../vite.config.mjs', import.meta.url)),
  server: { host: '127.0.0.1', port: 0, strictPort: true },
  plugins: []
});

const review = (id, values = {}) => ({
  id,
  description: `Synthetic ${id}`,
  amountMinor: '-1250',
  currency: 'AUD',
  date: '2026-09-20',
  kind: 'expense',
  status: 'posted',
  accountId: 'everyday',
  accountName: 'Synthetic everyday',
  category: 'Groceries',
  reviewReason: 'Category needs review',
  ...values
});

const adminSession = {
  authenticated: true,
  demo: false,
  user: { id: 'synthetic-admin', name: 'Synthetic administrator', role: 'admin' },
  currency: 'AUD',
  timeZone: 'UTC'
};

async function fixturePage(browser, base, { session = adminSession, reviews, transactions, viewport } = {}) {
  const page = await browser.newPage({ viewport: viewport || { width: 1440, height: 1000 } });
  const state = {
    reviews: [...reviews],
    posts: [],
    failNext: new Set(),
    transactions: transactions || (() => ({ transactions: [] })),
    errors: [],
    unexpected: []
  };
  const noStorage = await installBrowserStorageGuard(page);
  page.on('pageerror', (error) => state.errors.push(error.message));
  // Deliberate 409 and 503 fixtures make Chrome log the failed fetch; anything else is a defect.
  page.on(
    'console',
    (message) =>
      message.type() === 'error' &&
      !/Failed to load resource: the server responded with a status of (409|503)/.test(message.text()) &&
      state.errors.push(message.text())
  );
  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== base) {
      state.unexpected.push(request.url());
      await route.abort();
      return;
    }

    if (!url.pathname.startsWith('/api/')) {
      await route.continue();
      return;
    }

    const post = request.method() === 'POST' && url.pathname.match(/^\/api\/reviews\/(.+)$/);
    if (post) {
      const id = decodeURIComponent(post[1]);
      const body = request.postDataJSON();
      state.posts.push({ id, ...body });
      if (state.failNext.delete(id)) {
        await route.fulfill({ status: 409, json: { error: 'Transaction changed; reload and try again' } });
        return;
      }

      state.reviews = state.reviews.filter((r) => r.id !== id);
      await route.fulfill({ json: { message: 'Review resolved' } });
      return;
    }

    const answers = {
      '/api/session': () => session,
      '/api/dashboard': () => ({ incomeMinor: '0', expensesMinor: '0', netMinor: '0' }),
      '/api/reviews': () => ({ reviews: state.reviews }),
      '/api/categories': () => ({ catalog: [{ category: 'Groceries', name: 'Groceries', archived: false }] }),
      '/api/tags': () => ({ tags: [] }),
      '/api/transactions': () => state.transactions(url)
    };
    const answer = request.method() === 'GET' && answers[url.pathname];
    if (!answer) {
      state.unexpected.push(`${request.method()} ${url.pathname}`);
      await route.fulfill({ status: 500, json: { error: 'Unexpected synthetic request' } });
      return;
    }

    const data = await answer();
    await route.fulfill(data?.status ? { status: data.status, json: data.json } : { json: data });
  });
  state.assertClean = async () => {
    await noStorage();
    assert.deepEqual(state.errors, [], 'No page or console errors');
    assert.deepEqual(state.unexpected, [], 'No unmocked or external requests');
  };

  await page.goto(base + '/#review');
  await expect(page.getByRole('heading', { name: 'A second look.' })).toBeVisible();
  return { page, state };
}

const row = (page, id) => page.getByRole('group', { name: `Synthetic ${id}`, exact: true });

let browser;
try {
  await server.listen();
  const base = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox']
  });

  // Facts: a category review reads as Category: Needs review; other reasons lose their machine prefix.
  {
    const { page, state } = await fixturePage(browser, base, {
      reviews: [
        review('category', { category: 'Uncategorized' }),
        review('transfer', {
          kind: 'transfer',
          category: 'Transfers',
          reviewReason: 'Classification review: confirm provider transfer is internal or a card repayment'
        })
      ]
    });
    try {
      await expect(page.locator('.review-note')).toContainText(
        'Accepting a classification removes the transaction from this screen without changes.'
      );
      await expect(row(page, 'category').getByRole('term')).toHaveText(['Type', 'Category', 'Transaction']);
      await expect(row(page, 'category').getByRole('definition')).toHaveText(['Expense', 'Needs review', 'category']);
      await expect(row(page, 'transfer').getByRole('definition')).toHaveText([
        'Transfer, excluded from income and spending totals',
        'Transfers',
        'Confirm provider transfer is internal or a card repayment',
        'transfer'
      ]);
      const variants = await row(page, 'category')
        .locator('.review-actions button')
        .evaluateAll((buttons) => buttons.map((b) => b.className));
      assert.equal(variants.length, 3);
      assert.ok(
        variants.every((name) => name.includes('button-outline')),
        `Row actions share one style: ${variants}`
      );
      await state.assertClean();
      console.log('Passed review facts: compact Type, Category, Reason and Transaction lines; one button style');
    } finally {
      await page.close();
    }
  }

  // Bulk: three items resolve with one action, one request each, and the queue refreshes once.
  {
    const { page, state } = await fixturePage(browser, base, {
      reviews: ['one', 'two', 'three', 'four'].map((id) => review(id))
    });
    try {
      for (const id of ['one', 'two', 'three']) {
        await row(page, id).getByRole('checkbox').check();
      }

      await expect(page.getByText('3 selected', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Resolve 3 items', exact: true }).click();
      await expect(page.locator('.review-row')).toHaveCount(1);
      await expect(page.getByRole('status')).toContainText('Resolved 3 items.');
      assert.deepEqual(
        state.posts.map((p) => [p.id, p.action]),
        [
          ['one', 'keep'],
          ['two', 'keep'],
          ['three', 'keep']
        ]
      );
      await expect(row(page, 'four')).toBeFocused();
      await state.assertClean();
      console.log('Passed bulk resolution: one action, one audited request per item, focus on the next item');
    } finally {
      await page.close();
    }
  }

  // Partial failure: the failed item stays open, stays selected and is named in the error.
  {
    const { page, state } = await fixturePage(browser, base, {
      reviews: ['alpha', 'bravo', 'charlie'].map((id) => review(id))
    });
    try {
      state.failNext.add('bravo');
      await page.getByRole('checkbox', { name: 'Select all', exact: true }).check();
      await page.getByRole('button', { name: 'Resolve 3 items', exact: true }).click();
      const alert = page.locator('.review-bulk-error');
      await expect(alert).toContainText('Resolved 2 of 3.');
      await expect(alert).toContainText('Synthetic bravo (Transaction changed; reload and try again)');
      await expect(page.locator('.review-row')).toHaveCount(1);
      await expect(row(page, 'bravo').getByRole('checkbox')).toBeChecked();
      await page.getByRole('button', { name: 'Resolve 1 item', exact: true }).click();
      await expect(page.getByText('All clear for now')).toBeVisible();
      await state.assertClean();
      console.log('Passed partial bulk failure: survivors named, kept selected, retried in one action');
    } finally {
      await page.close();
    }
  }

  // Keyboard: move with arrows and J/K, select with X, resolve with A, focus follows.
  {
    const { page, state } = await fixturePage(browser, base, {
      reviews: ['first', 'second', 'third'].map((id) => review(id))
    });
    try {
      await row(page, 'first').focus();
      await page.keyboard.press('ArrowDown');
      await expect(row(page, 'second')).toBeFocused();
      await page.keyboard.press('j');
      await expect(row(page, 'third')).toBeFocused();
      await page.keyboard.press('k');
      await expect(row(page, 'second')).toBeFocused();
      await page.keyboard.press('x');
      await expect(row(page, 'second').getByRole('checkbox')).toBeChecked();
      await page.keyboard.press('x');
      await expect(row(page, 'second').getByRole('checkbox')).not.toBeChecked();
      await page.keyboard.press('a');
      await expect(page.locator('.review-row')).toHaveCount(2);
      await expect(row(page, 'third')).toBeFocused();
      await page.keyboard.press('a');
      await expect(row(page, 'first')).toBeFocused();
      await page.keyboard.press('a');
      await expect(page.getByText('All clear for now')).toBeVisible();
      await expect(page.getByRole('region', { name: 'Review queue' })).toBeFocused();
      assert.deepEqual(
        state.posts.map((p) => p.id),
        ['second', 'third', 'first']
      );
      await state.assertClean();
      console.log('Passed keyboard flow: arrows and J/K move, X selects, A resolves, focus follows');
    } finally {
      await page.close();
    }
  }

  // Picker: same-account, same-currency pending items only, exact amount first and preselected.
  {
    let reads = 0;
    const pending = [
      {
        id: 'p-far',
        status: 'pending',
        accountId: 'everyday',
        currency: 'AUD',
        amountMinor: '-9000',
        date: '2026-09-01',
        description: 'Far pending'
      },
      {
        id: 'p-exact',
        status: 'pending',
        accountId: 'everyday',
        currency: 'AUD',
        amountMinor: '-1250',
        date: '2026-09-18',
        description: 'Corner store pending'
      },
      {
        id: 'p-other',
        status: 'pending',
        accountId: 'savings',
        currency: 'AUD',
        amountMinor: '-1250',
        date: '2026-09-20',
        description: 'Other account'
      },
      {
        id: 'p-usd',
        status: 'pending',
        accountId: 'everyday',
        currency: 'USD',
        amountMinor: '-1250',
        date: '2026-09-20',
        description: 'Other currency'
      },
      {
        id: 'p-linked',
        status: 'pending',
        accountId: 'everyday',
        currency: 'AUD',
        amountMinor: '-1250',
        date: '2026-09-20',
        supersededBy: 'x',
        description: 'Already linked'
      }
    ];
    const { page, state } = await fixturePage(browser, base, {
      reviews: [review('posted', { reviewReason: 'Possible replacement for a pending transaction' })],
      transactions: (url) => {
        reads++;
        assert.equal(url.searchParams.get('status'), 'pending');
        assert.equal(url.searchParams.get('accountId'), 'everyday');
        assert.equal(url.searchParams.get('currency'), 'AUD');
        return reads === 1 ? { status: 503, json: { error: 'Pending lookup unavailable' } } : { transactions: pending };
      }
    });
    try {
      const picker = row(page, 'posted').getByRole('combobox', { name: 'Pending match', exact: true });
      await expect(row(page, 'posted').getByRole('alert')).toContainText('Pending lookup unavailable');
      await expect(picker).toBeDisabled();
      await row(page, 'posted').getByRole('button', { name: 'Try again', exact: true }).click();
      await expect(picker).toBeEnabled();
      const options = await picker.locator('option').allTextContents();
      assert.deepEqual(options, [
        'Choose a pending match',
        '2026-09-18 · Corner store pending · −$12.50',
        '2026-09-01 · Far pending · −$90.00'
      ]);
      await expect(picker).toHaveValue('p-exact');
      await row(page, 'posted').getByRole('button', { name: 'Link pending', exact: true }).click();
      await expect(page.getByText('All clear for now')).toBeVisible();
      assert.deepEqual(state.posts, [{ id: 'posted', action: 'link', pendingId: 'p-exact' }]);
      await state.assertClean();
      console.log('Passed pending picker: error and retry, compatible candidates only, exact match preselected');
    } finally {
      await page.close();
    }
  }

  // Empty picker: nothing to link, so Link pending stays disabled and Keep separate remains.
  {
    const { page, state } = await fixturePage(browser, base, {
      reviews: [review('lonely', { reviewReason: 'Identity check: possible replacement' })],
      transactions: () => ({ transactions: [] })
    });
    try {
      const picker = row(page, 'lonely').getByRole('combobox', { name: 'Pending match', exact: true });
      await expect(picker.locator('option')).toHaveText(['No pending items in this account']);
      await expect(row(page, 'lonely').getByRole('button', { name: 'Link pending', exact: true })).toBeDisabled();
      await expect(row(page, 'lonely').getByRole('button', { name: 'Keep separate', exact: true })).toBeEnabled();
      await state.assertClean();
      console.log('Passed empty picker state');
    } finally {
      await page.close();
    }
  }

  // View only: a member without edit access sees the item, cannot select or resolve it, and is told why.
  {
    const member = {
      ...adminSession,
      user: { id: 'synthetic-member', name: 'Synthetic member', role: 'member' },
      permissions: {
        accountAccess: true,
        accounts: [
          { accountId: 'everyday', access: 'edit' },
          { accountId: 'savings', access: 'view' }
        ]
      }
    };
    const long = `Synthetic ${'very-long-merchant-name-'.repeat(8)}`;
    const { page, state } = await fixturePage(browser, base, {
      session: member,
      viewport: { width: 390, height: 844 },
      reviews: [
        review('editable'),
        review('readonly', { accountId: 'savings', accountName: 'Synthetic savings' }),
        review('long', { description: long })
      ]
    });
    try {
      const readonly = row(page, 'readonly');
      await expect(readonly.getByRole('checkbox')).toBeDisabled();
      await expect(readonly.getByRole('button', { name: 'Accept classification', exact: true })).toBeDisabled();
      await expect(readonly).toContainText('View only: resolving this item needs edit access to Synthetic savings.');
      await page.getByRole('checkbox', { name: 'Select all', exact: true }).check();
      await expect(page.getByText('2 selected', { exact: true })).toBeVisible();
      await readonly.focus();
      await page.keyboard.press('a');
      await page.keyboard.press('x');
      assert.equal(state.posts.length, 0, 'View-only items ignore keyboard resolution');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(overflow <= 1, `No horizontal overflow at 390px (${overflow}px)`);
      await state.assertClean();
      console.log('Passed view-only rows and long descriptions at 390px');
    } finally {
      await page.close();
    }
  }
} finally {
  await browser?.close();
  await server.close();
}

console.log('Review queue hardening checks passed with synthetic fixtures.');
