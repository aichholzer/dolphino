import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { createServer } from 'vite';
import { installBrowserStorageGuard } from './browser-storage-guard.mjs';

// This test owns its Vite server and uses synthetic API fixtures only. It never
// reaches a database, a bank/provider, or an existing application session.
const root = fileURLToPath(new URL('..', import.meta.url));
const server = await createServer({
  root,
  configFile: fileURLToPath(new URL('../vite.config.js', import.meta.url)),
  server: { host: '127.0.0.1', port: 0, strictPort: true },
  plugins: [
    {
      name: 'workspace-session-test-harness',
      configureServer(vite) {
        vite.middlewares.use('/test-session-boundary', async (_request, response) => {
          // Supply a refreshed session without putting a test hook into production.
          const html = await vite.transformIndexHtml(
            '/test-session-boundary',
            `<!doctype html>
          <html><body><div id="root"></div><script type="module">
          import React from 'react';
          import { createRoot } from 'react-dom/client';
          import { FinancialWorkspace } from '/src/financial-workspace.jsx';
          import { workspaceIdentity } from '/src/lib/workspace-access.js';
          import '/src/style.css';
          function Harness() {
            const [session, setSession] = React.useState(window.initialTestSession);
            React.useEffect(() => { window.refreshTestSession = setSession; }, []);
            return React.createElement(FinancialWorkspace, {
              key: workspaceIdentity(session), session, onSession: setSession
            });
          }
          createRoot(document.getElementById('root')).render(React.createElement(Harness));
          </script></body></html>`
          );
          response.setHeader('Content-Type', 'text/html');
          response.end(html);
        });
      }
    }
  ]
});
await server.listen();
const base = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox']
});
const dashboard = { incomeMinor: '0', expensesMinor: '0', netMinor: '0' };
const priorAccount = { id: 'private-account', name: 'PRIVATE_PRIOR_ACCOUNT', currency: 'AUD', balanceMinor: '123456' };
const currentAccount = { id: 'current-account', name: 'CURRENT_ALLOWED_ACCOUNT', currency: 'AUD', balanceMinor: '100' };
const priorSession = {
  authenticated: true,
  demo: false,
  user: { id: 'prior-admin', name: 'Prior principal', role: 'admin' },
  currency: 'AUD',
  timeZone: 'UTC',
  permissions: { accessRevision: '1', accountAccess: true }
};
const memberSession = {
  ...priorSession,
  user: { id: 'new-member', name: 'Current principal', role: 'member' },
  permissions: { accessRevision: '1', accounts: [{ accountId: currentAccount.id, access: 'view' }] }
};

async function fixturePage(nextSession = memberSession) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const state = {
    session: structuredClone(priorSession),
    switched: false,
    outage: false,
    calls: [],
    errors: [],
    onRequest: null
  };
  state.assertNoStorageAccess = await installBrowserStorageGuard(page);
  page.on('pageerror', (error) => state.errors.push(error.message));
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    state.calls.push({ path, method: request.method(), url: request.url() });
    if (state.onRequest && (await state.onRequest(route, path))) {
      return;
    }
    let data = {};
    if (path === '/api/session') {
      data = state.session;
    } else if (path === '/api/logout') {
      state.session = { authenticated: false, demo: false };
    } else if (path === '/api/login') {
      state.session = structuredClone(nextSession);
      state.switched = true;
    } else if (
      state.switched &&
      state.outage &&
      ['/api/accounts', '/api/dashboard', '/api/transactions'].includes(path)
    ) {
      await route.fulfill({ status: 503, json: { error: 'Synthetic backend outage' } });
      return;
    } else if (path === '/api/dashboard') {
      data = dashboard;
    } else if (path === '/api/accounts') {
      data = { accounts: [state.switched ? currentAccount : priorAccount] };
    } else if (path === '/api/transactions') {
      data = { transactions: [], total: 0, hasMore: false };
    } else if (path === '/api/users') {
      data = { users: [], invitations: [] };
    } else if (path === '/api/users/grant-options') {
      data = { accounts: [], budgets: [] };
    } else if (path === '/api/settings/redbark') {
      data = { version: '2026-10-01.wattle', backfillDays: 90, encryptionAvailable: false, credentials: {} };
    } else if (path === '/api/settings/simplefin') {
      data = { backfillDays: 30, enabled: false, accounts: [] };
    } else if (path === '/api/reviews') {
      data = { reviews: [{ id: 'review-one', description: 'Synthetic review' }] };
    }
    await route.fulfill({ json: data });
  });
  return { page, state };
}

async function signInAgain(page) {
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.getByLabel('Email address', { exact: true }).fill('synthetic@example.test');
  await page.getByLabel('Your password', { exact: true }).fill('synthetic-password-only');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

async function settleRender(page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

try {
  {
    const page = await browser.newPage();
    try {
      const assertNoStorageAccess = await installBrowserStorageGuard(page);
      await page.goto('data:text/html,<title>Storage guard self-test</title>');
      const failures = await page.evaluate(() => {
        const caught = [];
        for (const attempt of [
          () => window.localStorage.getItem('synthetic-only'),
          () => window.localStorage.setItem('synthetic-only', 'never-stored'),
          () => {
            window.localStorage = {};
          }
        ]) {
          try {
            attempt();
          } catch (error) {
            caught.push(error.message);
          }
        }
        return caught;
      });
      assert.equal(failures.length, 3);
      await assert.rejects(assertNoStorageAccess, (error) => {
        assert.deepEqual(error.actual, [
          'read window.localStorage',
          'read window.localStorage',
          'write window.localStorage'
        ]);
        return true;
      });
      console.log('Passed storage-guard self-test: caught read/write exceptions still produce violations');
    } finally {
      await page.close();
    }
  }
  for (const samePrincipal of [false, true]) {
    const { page, state } = await fixturePage(
      samePrincipal ? { ...priorSession, user: { ...priorSession.user, name: 'Current principal' } } : memberSession
    );
    try {
      await page.goto(base);
      await page.getByText('Total income', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Transactions', exact: true }).click();
      await page.getByLabel('Search transactions').fill('PRIVATE_OLD_FILTER');
      await expect.poll(() => state.calls.some((call) => call.url.includes('PRIVATE_OLD_FILTER'))).toBe(true);
      await page.getByRole('button', { name: 'Accounts', exact: true }).click();
      await page.getByRole('heading', { name: priorAccount.name, exact: true }).waitFor();
      state.outage = true;
      await signInAgain(page);
      await page.getByText('Current principal', { exact: true }).waitFor();
      await page.getByRole('alert').filter({ hasText: 'Synthetic backend outage' }).waitFor();
      await expect(page.getByText(priorAccount.name, { exact: true })).toHaveCount(0);
      await expect(page.getByRole('heading', { name: 'Your data could not be loaded' })).toBeVisible();
      await page.getByRole('button', { name: 'Accounts', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: 'Synthetic backend outage' }).waitFor();
      await expect(page.getByText(priorAccount.name, { exact: true })).toHaveCount(0);
      state.outage = false;
      await page.getByRole('button', { name: 'Try again', exact: true }).click();
      await page.getByRole('heading', { name: currentAccount.name, exact: true }).waitFor();
      await page.getByRole('button', { name: 'Transactions', exact: true }).click();
      await expect(page.getByLabel('Search transactions')).toHaveValue('');
      await state.assertNoStorageAccess();
      assert.deepEqual(state.errors, []);
      console.log(
        `Passed ${samePrincipal ? 'same-principal relogin' : 'principal switch'}: failed reload cannot reveal prior data or filters`
      );
    } finally {
      await page.close();
    }
  }

  {
    const { page, state } = await fixturePage();
    let heldAccount;
    try {
      await page.goto(base);
      await page.getByText('Total income', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Accounts', exact: true }).click();
      await page.getByRole('heading', { name: priorAccount.name, exact: true }).waitFor();
      state.onRequest = async (route, path) => {
        if (path === '/api/accounts' && !state.switched) {
          heldAccount = route;
          return true;
        }
        return false;
      };
      await page.getByRole('button', { name: 'Accounts', exact: true }).click();
      await expect.poll(() => !!heldAccount).toBe(true);
      await signInAgain(page);
      await page.getByText('Current principal', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Accounts', exact: true }).click();
      await page.getByRole('heading', { name: currentAccount.name, exact: true }).waitFor();
      const oldResponse = page.waitForResponse((response) => response.request() === heldAccount.request());
      await heldAccount.fulfill({ json: { accounts: [priorAccount] } });
      await (await oldResponse).finished();
      await settleRender(page);
      await expect(page.getByRole('heading', { name: currentAccount.name, exact: true })).toBeVisible();
      await expect(page.getByText(priorAccount.name, { exact: true })).toHaveCount(0);
      await state.assertNoStorageAccess();
      assert.deepEqual(state.errors, []);
      console.log('Passed delayed prior-principal response: old requests cannot repopulate the new workspace');
    } finally {
      await page.close();
    }
  }

  {
    const { page, state } = await fixturePage();
    let heldMutation;
    try {
      state.onRequest = async (route, path) => {
        if (path === '/api/reviews/review-one') {
          heldMutation = route;
          return true;
        }
        return false;
      };
      await page.goto(base);
      await page.getByRole('button', { name: 'Review', exact: true }).click();
      await page.getByRole('button', { name: 'Keep separate', exact: true }).click();
      await expect.poll(() => !!heldMutation).toBe(true);
      await page.getByRole('button', { name: 'Accounts', exact: true }).click();
      await page.getByRole('heading', { name: priorAccount.name, exact: true }).waitFor();
      await heldMutation.fulfill({ json: { message: 'Review resolved' } });
      await expect.poll(() => state.calls.filter((call) => call.path === '/api/accounts').length).toBe(2);
      await page.getByRole('heading', { name: priorAccount.name, exact: true }).waitFor();
      assert.equal(state.calls.filter((call) => call.path === '/api/reviews').length, 1);
      await state.assertNoStorageAccess();
      assert.deepEqual(state.errors, []);
      console.log('Passed delayed mutation after navigation: the current page is refreshed');
    } finally {
      await page.close();
    }
  }

  {
    const { page, state } = await fixturePage();
    let heldSettings;
    try {
      state.onRequest = async (route, path) => {
        if (path === '/api/settings/redbark' && route.request().method() === 'PUT') {
          heldSettings = route;
          return true;
        }
        return false;
      };
      await page.goto(base);
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await page.getByRole('button', { name: 'Save Redbark settings', exact: true }).click();
      await expect.poll(() => !!heldSettings).toBe(true);
      await page.getByRole('button', { name: 'Accounts', exact: true }).click();
      await page.getByRole('heading', { name: priorAccount.name, exact: true }).waitFor();
      await heldSettings.fulfill({ json: { message: 'Synthetic settings saved' } });
      await expect.poll(() => state.calls.filter((call) => call.path === '/api/accounts').length).toBe(2);
      await page.getByRole('heading', { name: priorAccount.name, exact: true }).waitFor();
      assert.equal(state.calls.filter((call) => call.path === '/api/settings').length, 1);
      await state.assertNoStorageAccess();
      assert.deepEqual(state.errors, []);
      console.log('Passed delayed settings callback: current report data cannot be replaced by settings data');
    } finally {
      await page.close();
    }
  }

  {
    const { page, state } = await fixturePage();
    try {
      const editableSession = {
        ...memberSession,
        permissions: { accessRevision: '1', accounts: [{ accountId: priorAccount.id, access: 'edit' }] }
      };
      await page.addInitScript((session) => {
        window.initialTestSession = session;
      }, editableSession);
      await page.goto(`${base}/test-session-boundary`);
      await page.getByRole('button', { name: 'Accounts', exact: true }).click();
      await page.getByRole('button', { name: `Edit account ${priorAccount.name}`, exact: true }).click();
      await page.getByLabel('Account label', { exact: true }).fill('PRIVATE_UNSAVED_EDITOR');
      state.switched = true;
      state.outage = true;
      await page.evaluate((session) => window.refreshTestSession(session), {
        ...memberSession,
        permissions: { ...memberSession.permissions, accessRevision: '2' }
      });
      await page.getByRole('alert').filter({ hasText: 'Synthetic backend outage' }).waitFor();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Review', exact: true })).toHaveCount(0);
      await expect(page.getByText(priorAccount.name, { exact: true })).toHaveCount(0);
      state.outage = false;
      await page.getByRole('button', { name: 'Accounts', exact: true }).click();
      await page.getByRole('heading', { name: currentAccount.name, exact: true }).waitFor();
      await expect(page.getByRole('button', { name: `Edit account ${currentAccount.name}`, exact: true })).toHaveCount(
        0
      );
      await state.assertNoStorageAccess();
      assert.deepEqual(state.errors, []);
      console.log('Passed permission refresh: revoked data/editor state is disposed and new read-only grants apply');
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
  await server.close();
}
console.log('Workspace browser regressions and browser-storage guard passed using isolated synthetic fixtures.');
