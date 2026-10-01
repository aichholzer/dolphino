import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { calculatePeriodReport, calculateSelectionReport, domainError } from './engine.js';
const grantsSchema = z
  .object({
    accounts: z
      .array(
        z
          .object({
            accountId: z.string().min(1).max(200),
            access: z.enum(['view', 'edit'])
          })
          .strict()
      )
      .max(1000)
      .default([]),
    budgets: z
      .array(
        z
          .object({
            budgetId: z.string().uuid(),
            access: z.enum(['view', 'edit'])
          })
          .strict()
      )
      .max(1000)
      .default([])
  })
  .strict();
export async function ensureAccessSchema(pool) {
  await pool.query(await readFile(new URL('../migrations/010_grants.sql', import.meta.url), 'utf8'));
}
export async function validateGrants(c, input, { mode = 'live' } = {}) {
  const grants = grantsSchema.parse(input);
  if (
    new Set(grants.accounts.map((g) => g.accountId)).size !== grants.accounts.length ||
    new Set(grants.budgets.map((g) => g.budgetId)).size !== grants.budgets.length
  ) {
    throw domainError('Duplicate grants');
  }
  const a = await c.query('SELECT id FROM accounts WHERE mode=$1 AND id=ANY($2::text[])', [
    mode,
    grants.accounts.map((g) => g.accountId)
  ]);
  const b = await c.query('SELECT id FROM budgets WHERE mode=$1 AND id=ANY($2::uuid[])', [
    mode,
    grants.budgets.map((g) => g.budgetId)
  ]);
  if (a.rowCount !== grants.accounts.length || b.rowCount !== grants.budgets.length) {
    throw domainError('Grant target not found');
  }
  return grants;
}
export async function bumpAccessRevision(c, userId, { mode = 'live' } = {}) {
  await c.query(
    `INSERT INTO user_access_revisions(user_id,mode,revision) VALUES($1,$2,1) ON CONFLICT(user_id,mode) DO UPDATE SET revision=user_access_revisions.revision+1`,
    [userId, mode]
  );
}
async function accessRevision(c, userId, mode) {
  return String(
    (await c.query('SELECT revision FROM user_access_revisions WHERE user_id=$1 AND mode=$2', [userId, mode])).rows[0]
      ?.revision || '0'
  );
}
export async function validateAndSetGrants(c, userId, input, options = {}) {
  const grants = await validateGrants(c, input, options),
    mode = options.mode || 'live';
  await c.query('DELETE FROM user_account_grants WHERE user_id=$1 AND mode=$2', [userId, mode]);
  await c.query('DELETE FROM user_budget_grants WHERE user_id=$1 AND mode=$2', [userId, mode]);
  for (const g of grants.accounts) {
    await c.query('INSERT INTO user_account_grants(user_id,mode,account_id,permission) VALUES($1,$2,$3,$4)', [
      userId,
      mode,
      g.accountId,
      g.access
    ]);
  }
  for (const g of grants.budgets) {
    await c.query('INSERT INTO user_budget_grants(user_id,mode,budget_id,permission) VALUES($1,$2,$3,$4)', [
      userId,
      mode,
      g.budgetId,
      g.access
    ]);
  }
  await bumpAccessRevision(c, userId, { mode });
  return grants;
}
export async function listGrants(c, userId, { mode = 'live' } = {}) {
  const a = await c.query(
    'SELECT account_id,permission FROM user_account_grants WHERE user_id=$1 AND mode=$2 ORDER BY account_id',
    [userId, mode]
  );
  const b = await c.query(
    'SELECT budget_id,permission FROM user_budget_grants WHERE user_id=$1 AND mode=$2 ORDER BY budget_id',
    [userId, mode]
  );
  return {
    accounts: a.rows.map((g) => ({
      accountId: g.account_id,
      access: g.permission
    })),
    budgets: b.rows.map((g) => ({
      budgetId: g.budget_id,
      access: g.permission
    }))
  };
}
const denied = () => {
  throw Object.assign(Error('Not found'), { status: 404 });
};
const sanitize = (t) =>
  t.kind === 'transfer' || t.internalTransfer
    ? {
        ...t,
        description: 'Internal transfer',
        note: '',
        providerCategory: null,
        category: 'Transfers',
        splits: []
      }
    : t;
const budgetScope =
  'Granted budget totals include all household spending in that category and month; no underlying account or transaction access is granted.';
/** Request-scoped facade. No raw pool, ingestion, settings, rules or global taxonomy API. */
export async function createAccessStore(store, user) {
  if (!user) {
    denied();
  }
  if (user.role === 'admin') {
    return Object.assign(Object.create(store), {
      assertTransaction: async (id) => store.getTransaction(id),
      permissions: async () => ({
        accessRevision: await accessRevision(store.pool, user.id, store.mode),
        financialAccess: true,
        manageSettings: true,
        admin: true,
        accountAccess: true,
        budgetAccess: true,
        accounts: [],
        budgets: []
      })
    });
  }
  const grants = (c = store.pool) => listGrants(c, user.id, { mode: store.mode });
  const account = async (id, edit = false, c = store.pool) => {
    const g = (await grants(c)).accounts.find((g) => g.accountId === id);
    if (!g || (edit && g.access !== 'edit')) {
      denied();
    }
    return g;
  };
  const scoped = async (filters = {}, c = store.pool) => {
    const g = await grants(c);
    if (filters.accountId || filters.account) {
      await account(filters.accountId || filters.account, false, c);
    }
    return {
      ...filters,
      accountIds: g.accounts.map((a) => a.accountId),
      redactTransfers: true
    };
  };
  const assertTransaction = async (id, access = 'view') => {
    const tx = (await store.listTransactions(await scoped({ ids: [id] })))[0];
    if (!tx) {
      denied();
    }
    await account(tx.accountId, access === 'edit');
    return sanitize(tx);
  };
  const allowedBudgets = async () => {
    const g = await grants();
    return (await store.listBudgets()).filter((b) => g.budgets.some((x) => x.budgetId === b.id));
  };
  const report = async (filters, client) => {
    const calculate = async (c) => {
      const g = await grants(c),
        transactions = (await store.listTransactions(await scoped({ currency: filters.currency }, c), c)).map(sanitize);
      const r = calculatePeriodReport(transactions, [], {
        ...filters,
        today: new Intl.DateTimeFormat('en-CA', {
          timeZone: store.timezone,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit'
        }).format(new Date())
      });
      const accounts = (await store.listAccounts(c)).filter((a) => g.accounts.some((x) => x.accountId === a.id));
      // Budget grants explicitly authorize full totals, separately from account-scoped overview.
      const full = g.budgets.length ? await store.report(filters, c) : null;
      const attach = (row, fullRow) => ({
        ...row,
        budgets: (fullRow?.budgets || [])
          .filter((b) => g.budgets.some((x) => x.budgetId === b.id))
          .map((b) => ({
            ...b,
            transactionIds: [],
            summaryScope: budgetScope,
            access: g.budgets.find((x) => x.budgetId === b.id).access,
            canEdit: g.budgets.some((x) => x.budgetId === b.id && x.access === 'edit'),
            canDrill: false
          })),
        alerts: (fullRow?.alerts || []).filter((a) =>
          (fullRow?.budgets || []).some((b) => b.category === a.category && g.budgets.some((x) => x.budgetId === b.id))
        )
      });
      return {
        ...attach(r, full),
        monthly: r.monthly.map((m, i) => attach(m, full?.monthly[i])),
        accounts: accounts.map((a) => ({
          ...a,
          access: g.accounts.find((x) => x.accountId === a.id).access,
          canEdit: g.accounts.some((x) => x.accountId === a.id && x.access === 'edit')
        })),
        coverage: {
          accounts: accounts.map((a) => ({
            accountId: a.id,
            fetchedAt: a.fetchedAt,
            coverage: a.coverage,
            reconciled: false,
            reason: a.reconciliationReason
          })),
          complete: false,
          reason: 'Only granted accounts and imported date windows are included.'
        },
        summaryScope:
          'Overview and chart totals include granted accounts only. Budget totals follow separate explicit budget grants.'
      };
    };
    return client ? calculate(client) : store.atomic(calculate, { refresh: false });
  };
  const decorate = async (t) => ({
    ...sanitize(t),
    canEdit: (await grants()).accounts.some((g) => g.accountId === t.accountId && g.access === 'edit')
  });
  return {
    permissions: async () => {
      const g = await grants();
      return {
        accessRevision: await accessRevision(store.pool, user.id, store.mode),
        financialAccess: !!(g.accounts.length || g.budgets.length),
        manageSettings: false,
        admin: false,
        accountAccess: !!g.accounts.length,
        budgetAccess: !!g.budgets.length,
        ...g
      };
    },
    assertTransaction,
    listAccounts: async () => {
      const g = await grants();
      return (await store.listAccounts())
        .filter((a) => g.accounts.some((x) => x.accountId === a.id))
        .map((a) => ({
          ...a,
          access: g.accounts.find((x) => x.accountId === a.id).access,
          canEdit: g.accounts.some((x) => x.accountId === a.id && x.access === 'edit')
        }));
    },
    updateAccountSettings: async (id, patch) => {
      await account(id, true);
      return store.updateAccountSettings(id, patch);
    },
    listTransactions: async (filters = {}) =>
      Promise.all((await store.listTransactions(await scoped(filters))).map(decorate)),
    transactionPage: async (filters = {}) => {
      const page = await store.transactionPage(await scoped(filters));
      return {
        ...page,
        transactions: await Promise.all(page.transactions.map(decorate))
      };
    },
    getTransaction: assertTransaction,
    correctTransaction: async (id, patch) => {
      const prior = await assertTransaction(id, 'edit');
      if ((prior.kind === 'transfer' || prior.internalTransfer) && patch.kind && patch.kind !== 'transfer') {
        throw domainError('Only an administrator can change confirmed transfer semantics');
      }
      return decorate(await store.correctTransaction(id, patch));
    },
    listReviews: async () => Promise.all((await store.listTransactions(await scoped({ review: true }))).map(decorate)),
    resolveReview: async (id, value) => {
      await assertTransaction(id, 'edit');
      if (value.pendingId) {
        await assertTransaction(value.pendingId, 'edit');
      }
      return sanitize(await store.resolveReview(id, value));
    },
    audit: async (id) => {
      const t = await assertTransaction(id);
      return t.kind === 'transfer' || t.internalTransfer
        ? []
        : (await store.audit(id)).map((row) => ({
            action: row.action,
            created_at: row.created_at
          }));
    },
    listCategories: async () =>
      [
        ...new Set([
          'Uncategorized',
          ...(await store.listTransactions(await scoped()))
            .map(sanitize)
            .flatMap((t) => [t.category, ...t.splits.map((s) => s.category)]),
          ...(await allowedBudgets()).map((b) => b.category)
        ])
      ].sort(),
    listBudgets: allowedBudgets,
    saveBudget: async (b) => {
      const g = await grants();
      const current = (await store.listBudgets()).find(
        (x) => x.category === b.category && x.currency === (b.currency || 'AUD') && x.month === b.month
      );
      if (!current || !g.budgets.some((x) => x.budgetId === current.id && x.access === 'edit')) {
        denied();
      }
      return store.saveBudget(b);
    },
    deleteBudget: async (id) => {
      const g = await grants();
      if (!g.budgets.some((x) => x.budgetId === id && x.access === 'edit')) {
        denied();
      }
      return store.deleteBudget(id);
    },
    report,
    exportSnapshot: async (filters) =>
      store.atomic(
        async (c) => {
          const ranged = filters.allHistory === true || filters.allHistory === 'true' || filters.from || filters.to;
          const summary = ranged ? null : await report(filters, c),
            selection = { ...filters, paginated: false };
          if (summary) {
            delete selection.month;
            selection.from = summary.startDate;
            selection.to = summary.endDate;
          }
          const transactions = (await store.listTransactions(await scoped(selection, c), c)).map(sanitize);
          const selectionSummary = calculateSelectionReport(transactions, selection);
          return {
            filters,
            summaryScope:
              'Only granted accounts; budget summaries, when included, are separately authorized household category totals.',
            summary: summary || selectionSummary,
            selectionSummary,
            transactions
          };
        },
        { refresh: false }
      )
  };
}
