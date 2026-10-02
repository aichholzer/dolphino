import assert from 'node:assert/strict';
import test from 'node:test';
import {
  settingsSection,
  settingsSections,
  workspaceHash,
  workspaceRoute
} from '../src/features/settings/settings-navigation.mjs';

test('settings sections retain every requested destination in order', () => {
  assert.deepEqual(
    settingsSections.map((section) => section.label),
    ['Bank feeds', 'Categories', 'Members', 'Notifications', 'Data', 'AI features']
  );
});

test('settings links are deterministic, refreshable, and default unknown sections safely', () => {
  for (const section of settingsSections) {
    const route = { page: 'Settings', section: section.id };
    assert.deepEqual(workspaceRoute(workspaceHash(route)), route);
  }

  assert.deepEqual(workspaceRoute('#settings/missing'), { page: 'Settings', section: 'bank-feeds' });
  assert.deepEqual(workspaceRoute('#settings/redbark'), { page: 'Settings', section: 'bank-feeds' });
  assert.equal(settingsSection('__proto__'), 'bank-feeds');
  assert.deepEqual(workspaceRoute('#unknown'), { page: 'Overview', section: 'bank-feeds' });
  assert.deepEqual(workspaceRoute('#transactions'), { page: 'Transactions', section: 'bank-feeds' });
});
