import { ensureRedbarkSchema } from '../src/lib/worker.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { categoryFixture } from './helpers/category-fixture.mjs';
import { createManualLedger } from '../src/lib/manual-ledger.mjs';
import { accountBalances } from '../../shared/account-balances.mjs';
import { createAccessStore } from '../src/lib/access.mjs';
import { invokeFinanceTool } from '../src/lib/assistant-tools.mjs';
const request = (values) => ({ requestId: randomUUID(), ...values });
const account = (f, name = 'Cash', currency = 'AUD', balance = '10000') =>
  f.json(
    'admin',
    '/api/manual/accounts',
    'POST',
    request({ name, currency, openingDate: '2026-09-01', openingBalanceMinor: balance })
  );
const activity = (accountId, extra = {}) =>
  request({
    accountId,
    type: 'activity',
    kind: 'expense',
    date: '2026-09-12',
    amountMinor: '-1250',
    description: 'Work travel',
    category: 'Travel',
    tags: ['work', 'conference'],
    ...extra
  });
const accounts = async (f) => (await f.json('admin', '/api/accounts')).accounts;
const change = async (f, id, action, user = 'admin') => {
  const all =
    action === 'restore' ? (await f.json('admin', '/api/settings/deleted-accounts')).accounts : await accounts(f);
  return f.json(
    user,
    `/api/accounts/${id}/lifecycle`,
    'POST',
    request({ revision: all.find((a) => a.id === id).revision, action, reason: 'Synthetic lifecycle test' })
  );
};

const status = async (f, user, path, method, value, expected) => {
  const r = await f.http(user, path, method, value);
  assert.equal(r.status, expected, await r.text());
};

test('manual account exact ledger, reports, splits/tags, revisioned corrections and retained audit', async () => {
  const f = await categoryFixture();
  try {
    const baseline = await f.store.report({ month: '2026-09', currency: 'AUD' });
    const a = await account(f, 'Exact cash', 'AUD', '9007199254740993');
    assert.equal(a.account.balanceMinor, '9007199254740993');
    assert.equal((await f.store.report({ month: '2026-09', currency: 'AUD' })).incomeMinor, baseline.incomeMinor);
    const payload = activity(a.account.id, {
      splits: [
        { category: 'Travel', amountMinor: '-1000' },
        { category: 'Groceries', amountMinor: '-250' }
      ]
    });
    const [created, retry] = await Promise.all([
      f.json('admin', '/api/manual/entries', 'POST', payload),
      f.json('admin', '/api/manual/entries', 'POST', payload)
    ]);
    assert.equal(created.entry.id, retry.entry.id);
    assert.equal(created.accounts[0].balanceMinor, '9007199254739743');
    await status(f, 'admin', '/api/manual/entries', 'POST', { ...payload, amountMinor: '-1300' }, 409);
    const income = await f.json(
      'admin',
      '/api/manual/entries',
      'POST',
      activity(a.account.id, { kind: 'income', amountMinor: '2000', description: 'Pay', splits: [] })
    );
    let aNow = (await accounts(f)).find((x) => x.id === a.account.id);
    const adjustment = await f.json(
      'admin',
      '/api/manual/entries',
      'POST',
      request({
        type: 'adjustment',
        accountId: a.account.id,
        date: '2026-09-13',
        targetBalanceMinor: '9007199254740000',
        accountRevision: aNow.revision,
        reason: 'Counted cash'
      })
    );
    assert.equal(adjustment.entry.transactions[0].amountMinor, '-1743');
    let report = await f.store.report({ month: '2026-09', currency: 'AUD' });
    assert.equal(report.incomeMinor, (BigInt(baseline.incomeMinor) + 2000n).toString());
    assert.equal(report.expensesMinor, (BigInt(baseline.expensesMinor) + 1250n).toString());
    assert.equal(
      report.budgets.find((b) => b.category === 'Travel').spentMinor,
      (BigInt(baseline.budgets.find((b) => b.category === 'Travel').spentMinor) + 1000n).toString()
    );
    await f.json('admin', '/api/settings/categories', 'PATCH', { category: 'Travel', name: 'Trips' });
    await f.json('admin', '/api/settings/categories', 'DELETE', { category: 'Travel' });
    const found = await f.json('admin', '/api/transactions?allHistory=true&search=Trips&tag=work');
    assert.ok(found.transactions.some((t) => t.manualEntryId === created.entry.id));
    const changed = await f.json('admin', `/api/manual/entries/${created.entry.id}`, 'PATCH', {
      ...payload,
      requestId: randomUUID(),
      revision: 1,
      amountMinor: '-1400',
      splits: [{ category: 'Travel', amountMinor: '-1400' }]
    });
    assert.equal(changed.entry.revision, 2);
    await status(
      f,
      'admin',
      `/api/manual/entries/${created.entry.id}`,
      'PATCH',
      { ...payload, requestId: randomUUID(), revision: 1 },
      409
    );
    const voidPayload = request({ revision: 2, reason: 'Duplicate entry' });
    await f.json('admin', `/api/manual/entries/${created.entry.id}/void`, 'POST', voidPayload);
    await f.json('admin', `/api/manual/entries/${created.entry.id}/void`, 'POST', voidPayload);
    assert.ok(!(await f.store.listTransactions()).some((t) => t.manualEntryId === created.entry.id));
    const history = await f.json('admin', `/api/manual/entries/${created.entry.id}`);
    assert.equal(history.audit.length, 3);
    assert.equal(history.entry.voided, true);
    assert.equal(history.audit[0].after_value.transactions[0].amountMinor, '-1250');
    assert.equal(
      (await f.store.listTransactions({ includeVoided: true })).find((t) => t.manualEntryId === created.entry.id)
        .voided,
      true
    );
    await assert.rejects(f.pool.query('DELETE FROM manual_events WHERE entry_id=$1', [created.entry.id]), /immutable/);
    await assert.rejects(
      f.pool.query('DELETE FROM transactions WHERE manual_entry_id=$1', [income.entry.id]),
      /voided/
    );
    await status(
      f,
      'admin',
      `/api/manual/entries/${a.entry.id}/void`,
      'POST',
      request({ revision: 1, reason: 'No opening' }),
      400
    );
    await status(f, 'admin', '/api/manual/entries', 'POST', activity(a.account.id, { date: '2026-08-31' }), 400);
    await status(f, 'admin', '/api/manual/entries', 'POST', activity(a.account.id, { date: '2099-01-01' }), 400);
  } finally {
    await f.close();
  }
});

test('manual financial writes enforce origin, current roles, account grants, CSRF, strict input and idempotency permissions', async () => {
  const f = await categoryFixture();
  try {
    const a = await account(f),
      b = await account(f, 'Savings');
    await f.grant('editor', { accounts: [{ accountId: a.account.id, access: 'edit' }] });
    await f.grant('viewer', { accounts: [{ accountId: a.account.id, access: 'view' }] });
    for (const user of ['viewer', 'none', 'budget']) {
      await status(f, user, '/api/manual/entries', 'POST', activity(a.account.id), 404);
    }

    await status(f, 'anonymous', '/api/manual/entries', 'POST', activity(a.account.id), 401);
    await status(
      f,
      'editor',
      '/api/manual/accounts',
      'POST',
      request({ name: 'No', currency: 'AUD', openingDate: '2026-09-01', openingBalanceMinor: '0' }),
      403
    );
    await status(f, 'admin', '/api/manual/entries', 'POST', activity('visible'), 400);
    await status(f, 'admin', '/api/manual/entries', 'POST', activity(a.account.id, { amountMinor: 1.23 }), 400);
    await status(
      f,
      'admin',
      '/api/manual/entries',
      'POST',
      activity(a.account.id, { amountMinor: '-9223372036854775809' }),
      400
    );
    await status(f, 'admin', '/api/manual/entries', 'POST', activity(a.account.id, { actorId: f.users.admin.id }), 400);
    assert.equal(
      (await f.http('admin', '/api/manual/entries', 'POST', activity(a.account.id), 'https://evil.invalid')).status,
      403
    );
    const t = request({
      type: 'transfer',
      accountId: a.account.id,
      toAccountId: b.account.id,
      date: '2026-09-15',
      amountMinor: '200',
      receivedMinor: '200'
    });
    await status(f, 'editor', '/api/manual/entries', 'POST', t, 404);
    const created = await f.json('editor', '/api/manual/entries', 'POST', activity(a.account.id));
    await status(
      f,
      'viewer',
      `/api/manual/entries/${created.entry.id}/void`,
      'POST',
      request({ revision: 1, reason: 'No' }),
      404
    );
    await status(
      f,
      'editor',
      `/api/transactions/${created.entry.transactions[0].id}`,
      'PATCH',
      { kind: 'income' },
      400
    );
    await assert.rejects(
      f.store.ingest({ ...f.base, accountId: a.account.id, sourceId: 'evil', description: 'Feed intrusion' }),
      /Manual accounts/
    );
    await assert.rejects(
      f.store.updateAccount({ id: a.account.id, currency: 'AUD', balanceMinor: '1' }),
      /Manual accounts/
    );
    await assert.rejects(
      f.pool.query("UPDATE accounts SET source_type='feed',opening_entry_id=NULL WHERE mode='live' AND id=$1", [
        a.account.id
      ]),
      /permanent/
    );
    await assert.rejects(
      f.pool.query('UPDATE transactions SET manual_entry_id=$1 WHERE id=$2', [a.entry.id, f.tx.id]),
      /origin|permanent/
    );
    const permissionPayload = activity(a.account.id);
    await f.json('editor', '/api/manual/entries', 'POST', permissionPayload);
    await f.grant('editor', { accounts: [] });
    await status(f, 'editor', '/api/manual/entries', 'POST', permissionPayload, 404);
    // A stale caller-supplied admin role cannot override the actual database role.
    await f.pool.query("UPDATE household_users SET role='member' WHERE id=$1", [f.users.admin.id]);
    await assert.rejects(
      createManualLedger(f.store, f.users.admin).createAccount(
        request({ name: 'Stale admin', currency: 'AUD', openingDate: '2026-09-01', openingBalanceMinor: '0' })
      ),
      /Administrator/
    );
  } finally {
    await f.close();
  }
});

test('linked transfers are atomic, exact across currencies, permission scoped and protected by lifecycle state', async () => {
  const f = await categoryFixture();
  try {
    const a = await account(f),
      b = await account(f, 'USD cash', 'USD', '500');
    await f.grant('editor', {
      accounts: [
        { accountId: a.account.id, access: 'edit' },
        { accountId: b.account.id, access: 'edit' }
      ]
    });
    await f.grant('viewer', { accounts: [{ accountId: a.account.id, access: 'view' }] });
    const baseline = await f.store.report({ month: '2026-09', currency: 'AUD' });
    const transfer = request({
      type: 'transfer',
      accountId: a.account.id,
      toAccountId: b.account.id,
      date: '2026-09-15',
      amountMinor: '200',
      receivedMinor: '135'
    });
    const created = await f.json('editor', '/api/manual/entries', 'POST', transfer);
    assert.deepEqual(
      created.entry.transactions.map((t) => t.amountMinor),
      ['-200', '135']
    );
    assert.equal((await f.store.report({ month: '2026-09', currency: 'AUD' })).expensesMinor, baseline.expensesMinor);
    await status(f, 'viewer', `/api/manual/entries/${created.entry.id}`, 'GET', undefined, 404);
    await f.json('editor', `/api/manual/entries/${created.entry.id}`, 'PATCH', {
      ...transfer,
      requestId: randomUUID(),
      revision: 1,
      amountMinor: '300',
      receivedMinor: '202'
    });
    await change(f, b.account.id, 'freeze');
    assert.equal((await accounts(f)).find((x) => x.id === b.account.id).balanceMinor, '702');
    assert.equal(
      accountBalances(await accounts(f)).find((x) => x.currency === 'USD'),
      undefined
    );
    await status(
      f,
      'editor',
      `/api/manual/entries/${created.entry.id}/void`,
      'POST',
      request({ revision: 2, reason: 'Void' }),
      409
    );
    await change(f, b.account.id, 'delete');
    const visible = (await f.store.listTransactions()).filter((t) => t.manualEntryId === created.entry.id);
    assert.equal(visible.length, 1);
    assert.equal(visible[0].kind, 'transfer');
    assert.equal(visible[0].canEdit, false);
    const p = await f.json('admin', '/api/settings/deleted-accounts/preview', 'POST', { accountIds: [b.account.id] });
    assert.equal(p.linkedAccounts[0].id, a.account.id);
    await status(
      f,
      'admin',
      '/api/settings/deleted-accounts/purge',
      'POST',
      request({ accountIds: [b.account.id], previewToken: p.previewToken, confirmation: p.confirmation }),
      409
    );
    await change(f, b.account.id, 'restore');
    await change(f, b.account.id, 'unfreeze');
    await f.json(
      'editor',
      `/api/manual/entries/${created.entry.id}/void`,
      'POST',
      request({ revision: 2, reason: 'Void both legs' })
    );
    assert.equal((await accounts(f)).find((x) => x.id === a.account.id).balanceMinor, '10000');
    assert.equal((await accounts(f)).find((x) => x.id === b.account.id).balanceMinor, '500');
    await change(f, a.account.id, 'delete');
    await change(f, b.account.id, 'delete');
    const both = await f.json('admin', '/api/settings/deleted-accounts/preview', 'POST', {
      accountIds: [a.account.id, b.account.id]
    });
    assert.equal(both.linkedAccounts.length, 0);
    const purge = request({
      accountIds: [a.account.id, b.account.id],
      previewToken: both.previewToken,
      confirmation: both.confirmation
    });
    const result = await f.json('admin', '/api/settings/deleted-accounts/purge', 'POST', purge);
    assert.deepEqual(await f.json('admin', '/api/settings/deleted-accounts/purge', 'POST', purge), result);
    assert.equal((await f.pool.query('SELECT * FROM manual_entries')).rowCount, 0);
    assert.equal((await f.pool.query('SELECT * FROM manual_events')).rowCount, 0);
    assert.equal((await f.pool.query('SELECT * FROM account_tombstones')).rowCount, 2);
  } finally {
    await f.close();
  }
});

test('freeze preserves actuals, soft-delete hides history, restore returns totals, confirmed purge preserves unrelated evidence and blocks resurrection', async () => {
  const f = await categoryFixture();
  try {
    await f.store.updateAccount({ id: 'visible', currency: 'AUD', name: 'Everyday', balanceMinor: '123456' });
    await ensureRedbarkSchema(f.pool);
    await f.pool.query(
      "INSERT INTO redbark_fetches(account_id,fetched_at,raw) VALUES('visible',now(),'{\"synthetic\":true}'),('hidden',now(),'{\"keep\":true}')"
    );
    const original = await f.store.report({ month: '2026-09', currency: 'AUD' });
    const evidence = (await f.pool.query("SELECT * FROM provider_observations WHERE account_id='hidden'")).rows;
    await change(f, 'visible', 'freeze', 'editor');
    assert.equal((await f.store.report({ month: '2026-09', currency: 'AUD' })).expensesMinor, original.expensesMinor);
    assert.ok(!(await f.json('admin', '/api/accounts')).accountBalances.some((x) => x.balanceMinor === '123456'));
    await f.store.ingest({
      ...f.base,
      sourceId: 'while-frozen',
      description: 'Frozen feed update',
      amountMinor: '-99'
    });
    await assert.rejects(f.store.correctTransaction(f.tx.id, { tags: ['work'] }), /Unfreeze/);
    await change(f, 'visible', 'delete', 'editor');
    assert.equal(
      (await accounts(f)).some((x) => x.id === 'visible'),
      false
    );
    assert.equal(
      (await f.store.listTransactions()).some((t) => t.accountId === 'visible'),
      false
    );
    await status(f, 'admin', `/api/transactions/${f.tx.id}`, 'GET', undefined, 404);
    assert.equal((await f.json('viewer', '/api/accounts')).accounts.length, 0);
    const scoped = await createAccessStore(f.store, f.users.viewer);
    const assistantAccounts = await invokeFinanceTool(
      'finance_accounts',
      { currency: 'AUD' },
      { getFinance: async () => scoped }
    );
    assert.equal(assistantAccounts.data.accounts.length, 0);
    assert.equal(
      (await f.store.exportSnapshot({ month: '2026-09', currency: 'AUD' })).transactions.some(
        (t) => t.accountId === 'visible'
      ),
      false
    );
    assert.equal((await scoped.report({ month: '2026-09', currency: 'AUD' })).expensesMinor, '0');
    for (const user of ['viewer', 'editor', 'none', 'budget']) {
      await status(f, user, '/api/settings/deleted-accounts', 'GET', undefined, 403);
      await status(f, user, '/api/settings/deleted-accounts/preview', 'POST', { accountIds: ['visible'] }, 403);
    }

    await change(f, 'visible', 'restore');
    assert.equal(
      (await f.store.report({ month: '2026-09', currency: 'AUD' })).expensesMinor,
      (BigInt(original.expensesMinor) + 99n).toString()
    );
    assert.equal((await accounts(f)).find((x) => x.id === 'visible').frozen, true);
    await change(f, 'visible', 'delete');
    let p = await f.json('admin', '/api/settings/deleted-accounts/preview', 'POST', { accountIds: ['visible'] });
    await status(
      f,
      'admin',
      '/api/settings/deleted-accounts/purge',
      'POST',
      request({ accountIds: ['visible'], previewToken: p.previewToken, confirmation: 'DELETE' }),
      409
    );
    // A new hidden import invalidates a reviewed deletion snapshot.
    await f.store.ingest({
      ...f.base,
      sourceId: 'stale-preview',
      description: 'Latest hidden evidence',
      amountMinor: '-1'
    });
    await status(
      f,
      'admin',
      '/api/settings/deleted-accounts/purge',
      'POST',
      request({ accountIds: ['visible'], previewToken: p.previewToken, confirmation: p.confirmation }),
      409
    );
    p = await f.json('admin', '/api/settings/deleted-accounts/preview', 'POST', { accountIds: ['visible'] });
    const requestBody = request({
      accountIds: ['visible'],
      previewToken: p.previewToken,
      confirmation: p.confirmation
    });
    await status(f, 'none', '/api/settings/deleted-accounts/purge', 'POST', requestBody, 403);
    await f.json('admin', '/api/settings/deleted-accounts/purge', 'POST', requestBody);
    assert.deepEqual(
      (await f.pool.query("SELECT * FROM provider_observations WHERE account_id='hidden'")).rows,
      evidence
    );
    assert.equal((await f.pool.query("SELECT * FROM provider_observations WHERE account_id='visible'")).rowCount, 0);
    assert.equal(await f.store.ingest({ ...f.base, sourceId: 'resurrection', description: 'Must be ignored' }), null);
    await f.store.updateAccount({ id: 'visible', currency: 'AUD', balanceMinor: '999' });
    assert.equal(
      (await accounts(f)).some((a) => a.id === 'visible'),
      false
    );
    await assert.rejects(
      f.pool.query("INSERT INTO accounts(mode,id,name,currency) VALUES('live','visible','Recreated','AUD')"),
      /cannot be recreated/
    );
    await assert.rejects(f.pool.query('DELETE FROM provider_observations'), /immutable/);
    assert.equal(
      (await f.pool.query("SELECT * FROM account_lifecycle_events WHERE action='permanently-deleted'")).rowCount,
      1
    );
  } finally {
    await f.close();
  }
});

test('zero-revision upgraded feed lifecycle, auditable rollback, stale receipts and exact budget/alert restoration', async () => {
  const f = await categoryFixture();
  try {
    assert.equal((await accounts(f)).find((a) => a.id === 'visible').revision, 0);
    await change(f, 'visible', 'freeze');
    await change(f, 'visible', 'unfreeze');
    const before = await f.store.report({ month: '2026-09', currency: 'AUD' });
    const alerts = (
      await f.pool.query("SELECT * FROM budget_alerts WHERE mode='live' AND category='Travel' AND month='2026-09'")
    ).rows;
    assert.equal(alerts[0].resolved_at, null);
    await change(f, 'visible', 'delete');
    assert.notEqual(
      (await f.pool.query('SELECT resolved_at FROM budget_alerts WHERE id=$1', [alerts[0].id])).rows[0].resolved_at,
      null
    );
    await change(f, 'visible', 'restore');
    assert.equal(
      (await f.pool.query('SELECT resolved_at FROM budget_alerts WHERE id=$1', [alerts[0].id])).rows[0].resolved_at,
      null
    );
    assert.equal(
      (await f.store.report({ month: '2026-09', currency: 'AUD' })).budgets[0].spentMinor,
      before.budgets[0].spentMinor
    );
    const payload = request({
      name: 'Rollback envelope',
      currency: 'AUD',
      openingDate: '2026-09-01',
      openingBalanceMinor: '10000'
    });
    const a = await f.json('admin', '/api/manual/accounts', 'POST', payload);
    await f.pool.query(
      "CREATE FUNCTION fail_manual_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic audit outage'; END $$; CREATE TRIGGER fail_manual_audit BEFORE INSERT ON manual_events FOR EACH ROW EXECUTE FUNCTION fail_manual_audit()"
    );
    const failed = activity(a.account.id);
    await status(f, 'admin', '/api/manual/entries', 'POST', failed, 500);
    assert.equal((await accounts(f)).find((x) => x.id === a.account.id).balanceMinor, '10000');
    assert.equal(
      (await f.pool.query('SELECT * FROM manual_commands WHERE request_id=$1', [failed.requestId])).rowCount,
      0
    );
    await f.pool.query('DROP TRIGGER fail_manual_audit ON manual_events');
    const saved = await f.json('admin', '/api/manual/entries', 'POST', failed);
    assert.equal(saved.accounts[0].balanceMinor, '8750');
    await change(f, a.account.id, 'delete');
    await status(f, 'admin', '/api/manual/accounts', 'POST', payload, 409);
    const preview = await f.json('admin', '/api/settings/deleted-accounts/preview', 'POST', {
      accountIds: [a.account.id]
    });
    const purge = request({
      accountIds: [a.account.id],
      previewToken: preview.previewToken,
      confirmation: preview.confirmation
    });
    await f.pool.query(
      "CREATE FUNCTION fail_account_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic late delete failure'; END $$; CREATE TRIGGER fail_account_delete BEFORE DELETE ON accounts FOR EACH ROW EXECUTE FUNCTION fail_account_delete()"
    );
    await status(f, 'admin', '/api/settings/deleted-accounts/purge', 'POST', purge, 500);
    assert.equal((await f.pool.query('SELECT * FROM transactions WHERE account_id=$1', [a.account.id])).rowCount, 2);
    assert.equal(
      (await f.pool.query('SELECT * FROM account_tombstones WHERE account_id=$1', [a.account.id])).rowCount,
      0
    );
    await assert.rejects(f.pool.query('DELETE FROM provider_observations'), /immutable/);
    await f.pool.query('DROP TRIGGER fail_account_delete ON accounts');
    await f.json('admin', '/api/settings/deleted-accounts/purge', 'POST', purge);
    await status(f, 'admin', '/api/manual/accounts', 'POST', payload, 409);
    assert.deepEqual(
      (await f.pool.query('SELECT response FROM manual_commands WHERE request_id=$1', [payload.requestId])).rows[0]
        .response,
      { deleted: true }
    );
  } finally {
    await f.close();
  }
});
