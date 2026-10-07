import test from 'node:test';
import assert from 'node:assert/strict';
import { act, dom, renderHook, settle } from './react-harness.mjs';

const { useWorkspaceNavigation } = await import('../src/hooks/use-workspace-navigation.mjs');

const prompts = [];
let answer = true;
window.confirm = (message) => {
  prompts.push(message);
  return answer;
};

const discard = /^You have unsaved changes or a save in progress\. Leave and discard the draft\?/;

test('workspace navigation reads the hash, pushes new pages and replaces repeats', () => {
  history.replaceState(null, '', '/#settings/ai');
  const view = renderHook(() => useWorkspaceNavigation());
  const nav = () => view.result.current;
  assert.equal(nav().page, 'Settings');
  assert.equal(nav().section, 'ai');
  assert.equal(history.state.dolphinoPosition, 0);
  const length = history.length;
  act(() => assert.equal(nav().changeRoute('Budgets'), true));
  assert.equal(location.hash, '#budgets');
  assert.equal(history.state.dolphinoPosition, 1);
  assert.equal(history.length, length + 1);
  assert.equal(nav().page, 'Budgets');
  act(() => nav().changeRoute('Budgets'));
  assert.equal(history.length, length + 1, 'the same page replaces its entry');
  assert.equal(history.state.dolphinoPosition, 1);
  act(() => nav().changeRoute('Transactions', undefined, { transactionQuery: 'search=coffee' }));
  assert.equal(location.hash, '#transactions?search=coffee');
  assert.equal(nav().transactionQuery, 'search=coffee');
  act(() => nav().changeRoute('Overview', undefined, { transactionQuery: 'search=coffee' }));
  assert.equal(location.hash, '#overview', 'only Transactions carries a query');
  assert.equal(nav().transactionQuery, undefined);
  act(() => nav().changeRoute('Settings', 'not-a-section', { replace: true }));
  assert.equal(location.hash, '#settings/bank-feeds');
  assert.equal(history.state.dolphinoPosition, 3);
  view.unmount();
});

test('unsaved drafts block in-app navigation until confirmed', () => {
  history.replaceState(null, '', '/#rules');
  const view = renderHook(() => useWorkspaceNavigation());
  const nav = () => view.result.current;
  assert.equal(nav().confirmLeave(), true);
  act(() => nav().onDirtyChange(true, 'rule-editor'));
  act(() => nav().onDirtyChange(true, 'settings'));
  act(() => nav().onDirtyChange(false, 'settings'));
  answer = false;
  prompts.length = 0;
  act(() => assert.equal(nav().changeRoute('Accounts'), false));
  assert.equal(nav().page, 'Rules');
  assert.equal(location.hash, '#rules');
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], discard);
  act(() => assert.equal(nav().changeRoute('Accounts', undefined, { force: true }), true));
  assert.equal(nav().page, 'Accounts');
  assert.equal(prompts.length, 1, 'force skips the prompt');
  assert.equal(nav().confirmLeave(), true, 'navigating clears the drafts');
  act(() => nav().onDirtyChange(true));
  answer = true;
  act(() => assert.equal(nav().changeRoute('Review'), true));
  assert.equal(nav().page, 'Review');
  assert.equal(prompts.length, 2);
  view.unmount();
});

test('back, forward and typed hashes follow the same guard and revert when refused', async () => {
  history.replaceState(null, '', '/#overview');
  const view = renderHook(() => useWorkspaceNavigation());
  const nav = () => view.result.current;
  act(() => nav().changeRoute('Budgets'));
  act(() => nav().changeRoute('Rules'));
  history.back();
  await settle(20);
  assert.equal(nav().page, 'Budgets');
  assert.equal(location.hash, '#budgets');

  act(() => nav().onDirtyChange(true, 'budget-dialog'));
  answer = false;
  prompts.length = 0;
  history.back();
  await settle(20);
  assert.equal(nav().page, 'Budgets', 'a refused back keeps the page');
  assert.equal(location.hash, '#budgets', 'and moves the browser forward again');
  history.forward();
  await settle(20);
  assert.equal(nav().page, 'Budgets', 'a refused forward keeps the page');
  assert.equal(location.hash, '#budgets');
  assert.equal(prompts.length, 2);
  assert.match(prompts[0], discard);

  answer = true;
  history.forward();
  await settle(20);
  assert.equal(nav().page, 'Rules');
  assert.equal(nav().confirmLeave(), true, 'leaving drops the draft');
  act(() => nav().onDirtyChange(true, 'rule-editor'));
  answer = false;
  location.hash = '#accounts';
  await settle(20);
  assert.equal(nav().page, 'Rules', 'a refused typed hash keeps the page');
  assert.equal(location.hash, '#rules');
  act(() => nav().onDirtyChange(false, 'rule-editor'));
  const position = history.state.dolphinoPosition;
  location.hash = '#accounts';
  await settle(20);
  assert.equal(nav().page, 'Accounts');
  assert.equal(history.state.dolphinoPosition, position + 1, 'a typed hash gets the next position');
  view.unmount();
  const renders = view.result.renders;
  location.hash = '#overview';
  await settle(20);
  assert.equal(view.result.renders, renders, 'listeners leave with the workspace');
});

test('closing the tab with a draft asks the browser to confirm', () => {
  const view = renderHook(() => useWorkspaceNavigation());
  const unload = () => {
    const event = new dom.window.Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  };

  assert.equal(unload(), false);
  act(() => view.result.current.onDirtyChange(true, 'notes'));
  assert.equal(unload(), true);
  view.unmount();
  assert.equal(unload(), false);
});
