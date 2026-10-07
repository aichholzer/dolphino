import test from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, deferred, renderHook, settle, stubFetch } from './react-harness.mjs';

const { StrictMode } = await import('react');
const { useDraftGuard } = await import('../src/hooks/use-draft-guard.mjs');
const { useCategoryOptions } = await import('../src/hooks/use-category-options.mjs');
const { useBedrockModels } = await import('../src/hooks/use-bedrock-models.mjs');
const { useSettingsForm } = await import('../src/hooks/use-settings-form.mjs');
const { SettingsDrafts } = await import('../src/features/settings/settings-dirty.jsx');

test('draft guard reports its source while dirty and clears it on change and unmount', () => {
  const calls = [];
  const onDirtyChange = (dirty, source) => calls.push([dirty, source]);
  const view = renderHook(({ dirty }) => useDraftGuard(onDirtyChange, 'rule-editor', dirty), {
    props: { dirty: false }
  });
  view.rerender({ dirty: 'unsaved text' });
  view.unmount();
  assert.deepEqual(calls, [
    [false, 'rule-editor'],
    [false, 'rule-editor'],
    [true, 'rule-editor'],
    [false, 'rule-editor']
  ]);
  renderHook(() => useDraftGuard(undefined, 'no-listener', true)).unmount();
});

test('category options load per activation, default missing lists and surface API errors', async () => {
  const calls = stubFetch({
    '/categories': { catalog: [{ name: 'Groceries' }] },
    '/tags': { tags: ['work'] }
  });
  const view = renderHook(({ active }) => useCategoryOptions(active), { props: { active: false } });
  await settle();
  assert.equal(calls.length, 0, 'inactive pickers fetch nothing');
  view.rerender({ active: true });
  assert.deepEqual(view.result.current, { catalog: [], tags: [], error: '', loading: true });
  await settle();
  assert.deepEqual(view.result.current, {
    catalog: [{ name: 'Groceries' }],
    tags: ['work'],
    error: '',
    loading: false
  });
  assert.deepEqual(
    calls.map((c) => c.url),
    ['/api/categories', '/api/tags']
  );
  assert.equal(calls[0].options.credentials, 'same-origin');

  stubFetch({ '/categories': {}, '/tags': {} });
  view.rerender({ active: false });
  view.rerender({ active: true });
  await settle();
  assert.deepEqual(view.result.current, { catalog: [], tags: [], error: '', loading: false });

  stubFetch({
    '/categories': { catalog: [] },
    '/tags': Response.json({ error: 'Tags unavailable' }, { status: 503 })
  });
  view.rerender({ active: false });
  view.rerender({ active: true });
  await settle();
  assert.deepEqual(view.result.current, { catalog: [], tags: [], error: 'Tags unavailable', loading: false });

  const slow = deferred();
  stubFetch({ '/categories': () => slow.promise, '/tags': { tags: ['late'] } });
  view.rerender({ active: false });
  view.rerender({ active: true });
  const renders = view.result.renders;
  view.unmount();
  slow.resolve({ catalog: [{ name: 'Late' }] });
  await settle();
  assert.equal(view.result.renders, renders, 'a closed picker ignores a late response');
});

const saved = { discoveryRevision: 'rev-1', region: 'ap-southeast-2' };
const catalog = {
  revision: 'rev-1',
  region: 'ap-southeast-2',
  models: [{ id: 'anthropic.synthetic-v1', name: 'Synthetic' }],
  warnings: []
};
const discoveryError = /^Unable to load models\. Check your saved credentials and region/;

test('Bedrock catalog loads once per saved revision, even when React replays effects', async () => {
  const requests = [];
  const api = async (endpoint, options) => {
    requests.push({ endpoint, options });
    return catalog;
  };

  const view = renderHook(
    ({ eligible }) => useBedrockModels({ api, endpoint: '/settings/bedrock-models', saved, eligible }),
    { props: { eligible: false }, wrapper: StrictMode }
  );
  assert.deepEqual(
    { key: view.result.current.key, loading: view.result.current.loading, catalog: view.result.current.catalog },
    { key: null, loading: false, catalog: null }
  );
  view.result.current.retry();
  await settle();
  assert.equal(requests.length, 0);
  view.rerender({ eligible: true });
  assert.equal(view.result.current.loading, true);
  await settle();
  assert.equal(requests.length, 1, 'StrictMode replay sends no duplicate catalog read');
  assert.equal(requests[0].endpoint, '/settings/bedrock-models');
  assert.equal(requests[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(requests[0].options.body), { revision: 'rev-1' });
  assert.equal(view.result.current.loading, false);
  assert.equal(view.result.current.error, null);
  assert.deepEqual(view.result.current.catalog, catalog);
  view.result.current.retry();
  await settle();
  assert.equal(requests.length, 1, 'retry only follows an error');
  view.unmount();

  const mounted = renderHook(
    () => useBedrockModels({ api, endpoint: '/settings/bedrock-models', saved, eligible: true }),
    {
      wrapper: StrictMode
    }
  );
  await settle();
  assert.equal(requests.length, 2, 'the replayed mount effect is cancelled before it sends');
  assert.deepEqual(mounted.result.current.catalog, catalog);
  mounted.unmount();
});

test('Bedrock catalog rejects stale or malformed results and never shows raw provider errors', async () => {
  const cases = [
    { ...catalog, revision: 'rev-0' },
    { ...catalog, region: 'us-east-1' },
    { ...catalog, models: 'none' },
    { ...catalog, models: Array.from({ length: 1001 }, (_, i) => ({ id: `m${i}`, name: `M${i}` })) },
    { ...catalog, models: [{ id: 'anthropic.synthetic-v1' }] },
    { ...catalog, warnings: 'warn' },
    { ...catalog, warnings: [42] },
    new Error('AccessDenied for arn:aws:iam::123456789012:role/secret')
  ];
  for (const reply of cases) {
    const api = async () => {
      if (reply instanceof Error) {
        throw reply;
      }

      return reply;
    };

    const view = renderHook(() => useBedrockModels({ api, endpoint: '/models', saved, eligible: true }));
    await settle();
    assert.match(view.result.current.error, discoveryError);
    assert.ok(!view.result.current.error.includes('arn:aws'));
    assert.equal(view.result.current.catalog, null);
    assert.equal(view.result.current.loading, false);
    view.unmount();
  }

  const { warnings: _warnings, ...withoutWarnings } = catalog;
  const api = async () => withoutWarnings;
  const view = renderHook(() => useBedrockModels({ api, endpoint: '/models', saved, eligible: true }));
  await settle();
  assert.deepEqual(view.result.current.catalog, withoutWarnings, 'warnings are optional');
  view.unmount();
});

test('Bedrock catalog retries after an error, follows revision changes and aborts on unmount', async () => {
  const replies = [];
  const signals = [];
  const api = (_endpoint, options) => {
    signals.push(options.signal);
    const reply = deferred();
    replies.push(reply);
    return reply.promise;
  };

  const view = renderHook((props) => useBedrockModels({ api, endpoint: '/models', eligible: true, ...props }), {
    props: { saved }
  });
  await settle();
  await act(async () => replies[0].reject(new Error('throttled')));
  assert.match(view.result.current.error, discoveryError);
  act(() => view.result.current.retry());
  act(() => view.result.current.retry());
  await settle();
  assert.equal(replies.length, 2, 'a double click retries once');
  assert.equal(view.result.current.loading, true);
  view.rerender({ saved: { ...saved, discoveryRevision: 'rev-2' } });
  await settle();
  assert.equal(replies.length, 3);
  assert.equal(signals[1].aborted, true, 'the superseded read is cancelled');
  await act(async () => replies[1].resolve(catalog));
  assert.equal(view.result.current.catalog, null, 'a stale revision never publishes');
  await act(async () => replies[2].resolve({ ...catalog, revision: 'rev-2' }));
  assert.equal(view.result.current.catalog.revision, 'rev-2');
  view.rerender({ saved: { ...saved, discoveryRevision: 'rev-3' } });
  await settle();
  view.unmount();
  assert.equal(signals[3].aborted, true);
  await act(async () => replies[3].resolve({ ...catalog, revision: 'rev-3' }));
});

const select = (data) => ({ name: data.name });
const initial = { name: '' };

function settingsForm(api, { onDirtyChange } = {}) {
  return renderHook(
    ({ refreshKey }) => useSettingsForm({ api, endpoint: '/settings/feature', select, initial, refreshKey }),
    {
      props: { refreshKey: 0 },
      ...(onDirtyChange
        ? { wrapper: ({ children }) => createElement(SettingsDrafts, { onDirtyChange }, children) }
        : {})
    }
  );
}

test('settings form loads, tracks dirty state for the settings page and saves', async () => {
  const requests = [];
  let stored = { name: 'Saved', tools: [{ name: 'finance_search' }], updatedAt: 'one' };
  const api = async (endpoint, options = {}) => {
    requests.push({ endpoint, method: options.method || 'GET', body: options.body });
    if (options.method === 'PUT') {
      const { name } = JSON.parse(options.body);
      stored = { name, updatedAt: 'two' };
    }

    return stored;
  };

  const dirtyStates = [];
  const view = settingsForm(api, { onDirtyChange: (dirty) => dirtyStates.push(dirty) });
  const form = () => view.result.current;
  assert.equal(form().data, null);
  assert.deepEqual(form().values, initial);
  const early = form().save({ name: 'early' }, 'Saved.');
  await settle();
  assert.equal(await early, false, 'nothing saves before the first load');
  assert.deepEqual(form().values, { name: 'Saved' });
  assert.equal(form().dirty, false);
  act(() => form().setValues({ name: 'Edited' }));
  assert.equal(form().dirty, true);
  assert.equal(dirtyStates.at(-1), true, 'the settings page learns about the draft');
  const savedResults = [];
  let result;
  await act(async () => {
    result = await form().save({ name: 'Edited' }, 'Settings saved.', (value) => savedResults.push(value));
  });
  assert.equal(result, true);
  assert.equal(requests.at(-1).method, 'PUT');
  assert.equal(requests.at(-1).body, JSON.stringify({ name: 'Edited' }));
  assert.equal(form().notice, 'Settings saved.');
  assert.equal(form().error, '');
  assert.equal(form().busy, false);
  assert.equal(form().dirty, false);
  assert.deepEqual(form().data.tools, [{ name: 'finance_search' }], 'PUT responses keep the GET tool catalog');
  assert.deepEqual(savedResults, [{ name: 'Edited', updatedAt: 'two' }]);
  assert.equal(dirtyStates.at(-1), false);
  await act(async () => {
    result = await form().save({ name: 'Again' }, 'Saved again.', () => {
      throw new Error('status refresh failed');
    });
  });
  assert.equal(result, true);
  assert.equal(form().error, 'Settings saved, but the workspace status could not be refreshed.');
  view.unmount();
  assert.equal(dirtyStates.at(-1), false);
});

test('settings form keeps edits made during a save or a refresh and reports failures', async () => {
  let pending;
  let reads = 0;
  const api = (_endpoint, options = {}) => {
    if (options.method === 'PUT') {
      pending = deferred();
      return pending.promise;
    }

    reads++;
    return Promise.resolve({ name: `Read ${reads}` });
  };

  const view = settingsForm(api);
  const form = () => view.result.current;
  await settle();
  assert.deepEqual(form().values, { name: 'Read 1' });

  let saving;
  act(() => {
    saving = form().save({ name: 'First' }, 'Saved.');
  });
  assert.equal(form().busy, true);
  assert.equal(await form().save({ name: 'Second' }, 'Saved.'), false, 'one save at a time');
  act(() => form().setValues({ name: 'Typed during save' }));
  await act(async () => pending.resolve({ name: 'First' }));
  assert.equal(await saving, false);
  assert.equal(form().outdated, true);
  assert.match(form().notice, /^Settings saved, but the form changed while saving/);
  assert.deepEqual(form().values, { name: 'Typed during save' });

  act(() => {
    saving = form().save({ name: 'Typed during save' }, 'Saved.');
  });
  await act(async () => pending.reject(new Error('Provider key rejected')));
  assert.equal(await saving, false);
  assert.equal(form().error, 'Provider key rejected');
  assert.equal(form().busy, false);

  act(() => {
    saving = form().save({ name: 'Typed during save' }, 'Saved.');
  });
  act(() => form().setValues({ name: 'Typed again' }));
  await act(async () => pending.reject(new Error('Provider key rejected')));
  assert.equal(form().error, 'Settings were not saved. Your current changes are retained; save again to retry.');

  view.rerender({ refreshKey: 1 });
  await settle();
  assert.equal(form().outdated, true, 'a refresh never overwrites a draft');
  assert.deepEqual(form().values, { name: 'Typed again' });

  window.confirm = () => false;
  act(() => form().discardAndReload());
  await settle();
  assert.deepEqual(form().values, { name: 'Typed again' }, 'a refused confirmation keeps the draft');
  window.confirm = () => true;
  act(() => form().discardAndReload());
  await settle();
  assert.equal(form().outdated, false);
  assert.equal(form().dirty, false);
  assert.deepEqual(form().values, { name: `Read ${reads}` });

  act(() => {
    saving = form().save({ name: 'Unmounted' }, 'Saved.');
  });
  view.unmount();
  pending.resolve({ name: 'Unmounted' });
  assert.equal(await saving, false, 'a closed section publishes nothing');
});

test('settings form surfaces load errors and ignores a read that finishes after unmount', async () => {
  const view = settingsForm(async () => {
    throw new Error('Settings unavailable');
  });
  await settle();
  assert.equal(view.result.current.error, 'Settings unavailable');
  assert.equal(view.result.current.data, null);
  view.unmount();

  const slow = deferred();
  const late = settingsForm(() => slow.promise);
  const renders = late.result.renders;
  late.unmount();
  slow.resolve({ name: 'Late' });
  await settle();
  assert.equal(late.result.renders, renders);
});
