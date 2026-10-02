import { randomBytes } from 'node:crypto';
import { categoryFixture } from './category-fixture.mjs';
import { createSettingsStore } from '../../src/lib/settings.mjs';
import { createPocketSmithIntegration } from '../../src/lib/pocketsmith.mjs';

export const testPocketSmithKey = 'synthetic-pocket-key-not-a-live-credential';

export const pocketAccount = (id = 9001, overrides = {}) => ({
  id,
  name: 'Ocean checking',
  currency_code: 'AUD',
  current_balance: 1234.56,
  current_balance_date: '2026-10-02',
  current_balance_in_base_currency: 9876.54,
  current_balance_exchange_rate: 8,
  safe_balance: 1000,
  updated_at: '2026-10-02T00:00:00Z',
  ...overrides
});

export const pocketTransaction = (id = 101, overrides = {}) => ({
  id,
  amount: -12.34,
  amount_in_base_currency: -98.72,
  type: 'debit',
  date: '2026-10-01',
  status: 'posted',
  payee: 'Synthetic train',
  updated_at: '2026-10-02T00:00:00.000001Z',
  is_transfer: false,
  needs_review: false,
  category: { id: 50, title: 'Travel', is_transfer: false, refund_behaviour: 'credits_are_refunds' },
  labels: ['Work', 'Conference'],
  note: 'Provider note',
  transaction_account: pocketAccount(),
  ...overrides
});

export async function pocketSmithFixture({ databaseTimezone } = {}) {
  let pocketsmith,
    settings,
    config,
    hook = null,
    clock = Date.parse('2026-10-02T12:00:00Z');
  const calls = [],
    data = { userId: 42, accounts: [pocketAccount()], transactions: [pocketTransaction()] };
  const request = async (url, options) => {
    calls.push({ url: url.href, key: options.key });
    if (hook) {
      const response = await hook(url, options);
      if (response) {
        return response;
      }
    }

    let body;
    if (url.pathname === '/v2/me') {
      body = { id: data.userId };
    } else if (url.pathname.endsWith('/transaction_accounts')) {
      body = data.accounts;
    } else if (url.pathname.endsWith('/accounts')) {
      body = [
        {
          id: 700,
          title: 'Grouped accounts',
          currency_code: 'AUD',
          current_balance: 999999,
          transaction_accounts: data.accounts,
          primary_transaction_account: data.accounts[0]
        }
      ];
    } else if (url.pathname.endsWith('/transactions')) {
      const rows = data.transactions.filter(
        (row) =>
          String(row.transaction_account.id) === url.pathname.split('/')[3] &&
          row.date >= url.searchParams.get('start_date') &&
          row.date <= url.searchParams.get('end_date') &&
          (!url.searchParams.get('updated_since') ||
            Date.parse(row.updated_at) >= Date.parse(url.searchParams.get('updated_since')))
      );
      const page = Number(url.searchParams.get('page'));
      const next = new URL(url);
      next.searchParams.set('page', String(page + 1));
      return {
        status: 200,
        body: JSON.stringify(rows.slice((page - 1) * 500, page * 500)),
        headers: {
          total: String(rows.length),
          'per-page': '500',
          ...(rows.length > page * 500 ? { link: `<${next.href}>; rel="next"` } : {})
        }
      };
    } else if (/\/transaction_accounts\/\d+$/.test(url.pathname)) {
      body = data.accounts.find((row) => String(row.id) === url.pathname.split('/')[3]);
      if (!body) {
        return { status: 404, body: 'Synthetic missing account' };
      }
    } else {
      throw Error('Unexpected synthetic PocketSmith request');
    }

    return { status: 200, body: JSON.stringify(body), headers: {} };
  };

  const f = await categoryFixture({
    databaseTimezone,
    appOptions: async (options) => {
      config = options.config;
      config.appSecret = randomBytes(32).toString('base64');
      settings = createSettingsStore({ pool: options.pool, appSecret: config.appSecret });
      await settings.init();
      pocketsmith = createPocketSmithIntegration({ ...options, settings, request, now: () => clock });
      return {
        settings,
        pocketsmith,
        simplefin: {
          status: async () => ({
            enabled: false,
            configured: false,
            backfillDays: 30,
            accounts: [],
            jobs: [],
            providerErrors: []
          })
        },
        importHealth: { status: async () => ({ accounts: [], jobs: [], categories: {}, redbark: {} }) }
      };
    }
  });
  const state = () => f.json('admin', '/api/settings/pocketsmith');
  const save = async (values = {}) => {
    const s = await state();
    return f.json('admin', '/api/settings/pocketsmith', 'PUT', {
      revision: s.revision,
      enabled: s.enabled,
      backfillDays: s.backfillDays,
      ...values
    });
  };

  const connect = async () => {
    await save({ key: testPocketSmithKey });
    const s = await state();
    return f.json('admin', '/api/settings/pocketsmith/test', 'POST', { revision: s.revision });
  };

  const enable = async () => {
    let s = await state();
    for (const account of s.accounts) {
      s = await f.json('admin', '/api/settings/pocketsmith/account', 'POST', {
        revision: s.revision,
        accountId: account.id,
        enabled: true
      });
    }

    return save({ enabled: true });
  };

  const due = async () =>
    f.pool.query('UPDATE pocketsmith_accounts SET next_attempt=$1', [new Date(clock).toISOString()]);
  const finishBackfill = async () => {
    for (let i = 0; i < 100; i++) {
      await f.pool.query('UPDATE pocketsmith_accounts SET next_attempt=$1 WHERE backfill_next IS NOT NULL', [
        new Date(clock).toISOString()
      ]);
      await pocketsmith.tick();
      const s = await state();
      if (s.accounts.some((a) => a.lastError)) {
        throw Error(JSON.stringify(s.accounts.map((a) => a.lastError)));
      }

      if (s.accounts.every((a) => !a.backfillNext)) {
        return;
      }
    }

    throw Error('Synthetic backfill did not complete');
  };

  return {
    ...f,
    pocketsmith,
    settings,
    config,
    data,
    calls,
    state,
    save,
    connect,
    enable,
    due,
    finishBackfill,
    setHook(value) {
      hook = value;
    },
    advance(ms = 4 * 3600000 + 1000) {
      clock += ms;
    },
    async close() {
      await pocketsmith.stop();
      await f.close();
    }
  };
}
