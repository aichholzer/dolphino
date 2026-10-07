import test from 'node:test';
import assert from 'node:assert/strict';
import { act, deferred, renderHook, settle, stubFetch } from './react-harness.mjs';

const { useWorkspaceData } = await import('../src/hooks/use-workspace-data.mjs');
const { useTransactionFilters } = await import('../src/hooks/use-transaction-filters.mjs');
const { writeTransactionRoute } = await import('../src/lib/transaction-route.mjs');

const demo = { demo: true, authenticated: false };
function workspace(props) {
  return renderHook((value) => useWorkspaceData(value), { props: { query: 'month=2026-10', search: '', ...props } });
}

test('workspace data reads the session first and reports a failed read', async () => {
  const sessions = [];
  const onSession = (value) => sessions.push(value);
  stubFetch({ '/session': { authenticated: false, setupRequired: true } });
  let view = workspace({ session: null, onSession, page: 'Overview' });
  await settle();
  assert.deepEqual(sessions, [{ authenticated: false, setupRequired: true }]);
  view.unmount();

  stubFetch({ '/session': Response.json({ error: 'Database unavailable' }, { status: 503 }) });
  view = workspace({ session: null, onSession, page: 'Overview' });
  await settle();
  assert.equal(view.result.current.error, 'Database unavailable');
  assert.equal(view.result.current.loading, false);
  assert.equal(sessions.length, 1);
  view.unmount();
});

test('workspace data loads only pages the session may open', async () => {
  const onSession = () => {};
  let calls = stubFetch({});
  for (const session of [
    { authenticated: true, user: { role: 'member' }, permissions: {} },
    { authenticated: false, user: null, permissions: { accounts: [{ accountId: 'a', access: 'view' }] } }
  ]) {
    const view = workspace({ session, onSession, page: 'Overview' });
    await settle();
    assert.equal(view.result.current.loading, true);
    view.unmount();
  }

  const viewer = { authenticated: true, user: { role: 'member' }, permissions: { accountAccess: true } };
  let view = workspace({ session: viewer, onSession, page: 'Rules' });
  await settle();
  view.unmount();
  assert.equal(calls.length, 0, 'no grant, no request');

  calls = stubFetch({ '/dashboard?month=2026-10': { expensesMinor: '1250' } });
  view = workspace({ session: viewer, onSession, page: 'Overview' });
  await settle();
  assert.deepEqual(view.result.current.data, { expensesMinor: '1250' });
  assert.equal(view.result.current.loading, false);
  assert.equal(view.result.current.error, '');
  assert.deepEqual(
    calls.map((c) => c.url),
    ['/api/dashboard?month=2026-10']
  );
  view.unmount();

  stubFetch({ '/accounts': Response.json({ error: 'Not found' }, { status: 404 }) });
  view = workspace({ session: demo, onSession, page: 'Accounts' });
  await settle();
  assert.equal(view.result.current.error, 'Not found');
  assert.equal(view.result.current.loading, false);
  view.unmount();
});

test('workspace data debounces search, drops stale reports and refreshes in the background', async () => {
  const replies = [];
  const calls = stubFetch({
    '/transactions': () => {
      const reply = deferred();
      replies.push(reply);
      return reply.promise;
    }
  });
  const onSession = () => {};
  const view = workspace({ session: demo, onSession, page: 'Transactions', query: 'search=c', search: 'c' });
  await settle();
  assert.equal(calls.length, 0, 'typing waits 220 ms');
  await settle(240);
  assert.equal(calls.length, 1);
  view.rerender({ session: demo, onSession, page: 'Transactions', query: 'search=co', search: 'co' });
  await settle(240);
  assert.equal(calls.length, 2);
  await act(async () => replies[1].resolve({ total: 2 }));
  await settle();
  await act(async () => replies[0].resolve({ total: 99 }));
  await settle();
  assert.deepEqual(view.result.current.data, { total: 2 }, 'the older search never overwrites the newer one');
  assert.equal(view.result.current.loading, false);

  let refreshed;
  act(() => {
    refreshed = view.result.current.refreshCurrent();
  });
  assert.equal(view.result.current.loading, false, 'background refreshes keep the page in place');
  await settle();
  await act(async () => replies[2].resolve({ total: 3 }));
  await refreshed;
  assert.deepEqual(view.result.current.data, { total: 3 });

  act(() => view.result.current.resetPage());
  assert.equal(view.result.current.loading, true);
  assert.deepEqual(view.result.current.data, {});
  view.unmount();
});

test('workspace mutations post JSON, reload the current page and fail closed after unmount', async () => {
  let reads = 0;
  const calls = stubFetch({
    '/budgets?month=2026-10': () => ({ reads: ++reads }),
    '/budgets': ({ options }) =>
      options.method === 'DELETE'
        ? Response.json({ error: 'Budget is locked' }, { status: 409 })
        : { message: options.body.includes('Groceries') ? 'Budget saved.' : undefined }
  });
  const view = workspace({ session: demo, onSession: () => {}, page: 'Budgets' });
  await settle();
  assert.deepEqual(view.result.current.data, { reads: 1 });
  let ok;
  await act(async () => {
    ok = await view.result.current.mutate('/budgets', { category: 'Groceries' });
  });
  assert.equal(ok, true);
  assert.equal(view.result.current.notice, 'Budget saved.');
  assert.deepEqual(view.result.current.data, { reads: 2 }, 'the page reloads after a change');
  const post = calls.find((c) => c.options.method === 'POST');
  assert.equal(post.options.body, JSON.stringify({ category: 'Groceries' }));
  assert.equal(post.options.headers['Content-Type'], 'application/json');
  await act(async () => {
    ok = await view.result.current.mutate('/budgets', { category: 'Rent' }, 'PUT');
  });
  assert.equal(view.result.current.notice, 'Changes saved.');
  await act(async () => {
    ok = await view.result.current.mutate('/budgets', {}, 'DELETE');
  });
  assert.equal(ok, false);
  assert.equal(view.result.current.error, 'Budget is locked');
  assert.equal(view.result.current.busy, false);
  act(() => view.result.current.setNotice(''));
  assert.equal(view.result.current.notice, '');

  const slow = deferred();
  stubFetch({ '/budgets': () => slow.promise });
  let pending;
  act(() => {
    pending = view.result.current.mutate('/budgets', { category: 'Late' });
  });
  view.unmount();
  slow.resolve({ message: 'Too late' });
  assert.equal(await pending, false);
});

test('transaction filters live in the URL on the Transactions page and in memory elsewhere', async () => {
  const routes = [];
  const changeRoute = (...args) => routes.push(args);
  const view = renderHook(
    ({ page, transactionQuery }) => useTransactionFilters('2026-10', 'AUD', { page, transactionQuery, changeRoute }),
    { props: { page: 'Transactions', transactionQuery: 'currency=NZD&month=2026-08&search=coffee&page=3' } }
  );
  const current = () => view.result.current;
  assert.equal(current().filters.search, 'coffee');
  assert.equal(current().filters.txPage, 3);
  assert.equal(current().routeMonth, '2026-08');
  assert.equal(current().routeCurrency, 'NZD');
  act(() => current().updateFilters({ category: 'Groceries' }));
  const expected = { ...current().filters, category: 'Groceries', txPage: 1 };
  assert.deepEqual(routes.at(-1), [
    'Transactions',
    undefined,
    { replace: true, transactionQuery: writeTransactionRoute(expected, { month: '2026-08', currency: 'NZD' }) }
  ]);
  act(() => current().updateFilters({ txPage: 4 }, { month: '2026-09', currency: 'EUR' }));
  assert.match(routes.at(-1)[2].transactionQuery, /month=2026-09/);
  assert.match(routes.at(-1)[2].transactionQuery, /currency=EUR/);
  assert.match(routes.at(-1)[2].transactionQuery, /page=4/);

  view.rerender({ page: 'Overview', transactionQuery: undefined });
  assert.equal(current().filters.search, 'coffee', 'the last URL filters are remembered off the page');
  assert.equal(current().routeMonth, '2026-10');
  assert.equal(current().routeCurrency, 'AUD');
  const sent = routes.length;
  act(() => current().updateFilters({ search: 'tea', txPage: 2 }));
  assert.equal(routes.length, sent, 'off the page, the URL is left alone');
  assert.equal(current().filters.search, 'tea');
  assert.equal(current().filters.txPage, 2);
  act(() => current().updateFilters({ kind: 'expense' }));
  assert.equal(current().filters.txPage, 1, 'any other change returns to page one');
  view.unmount();
});
