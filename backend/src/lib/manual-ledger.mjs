import { createHash, randomUUID } from 'node:crypto';
import { domainError, minor, validateSplits } from './engine.mjs';
import { assertCategoryAvailable } from './category-catalog.mjs';
import { saveManualTags } from './rule-tags.mjs';
import { manualAccountSchema, manualEntrySchema, manualEditSchema, manualVoidSchema } from './manual-schemas.mjs';

const failure = (message, status = 400) => Object.assign(Error(message), { status });
const missing = () => {
  throw failure('Not found', 404);
};

const date = (value) =>
  value instanceof Date
    ? `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
    : String(value).slice(0, 10);
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])])
        )
      : value;
export const ledgerToday = (store) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: store.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());

export async function assertFeedAccount(c, mode, id) {
  if ((await c.query('SELECT 1 FROM account_tombstones WHERE mode=$1 AND account_id=$2', [mode, id])).rowCount) {
    return false;
  }

  if (
    (await c.query('SELECT source_type FROM accounts WHERE mode=$1 AND id=$2', [mode, id])).rows[0]?.source_type ===
    'manual'
  ) {
    throw domainError('Manual accounts cannot receive feed balances or imported transactions');
  }

  return true;
}

// Opening/adjustment rows share the ledger for history and exact balance arithmetic,
// but the reporting engine treats them separately from income, spending and transfers.
export async function manualBalance(c, mode, accountId, through, exceptEntry = null) {
  return (
    await c.query(
      `SELECT COALESCE(sum(amount_minor),0)::text amount FROM transactions
    WHERE mode=$1 AND account_id=$2 AND manual_entry_id IS NOT NULL AND voided_at IS NULL
      AND date<=$3::date AND ($4::uuid IS NULL OR manual_entry_id<>$4)`,
      [mode, accountId, through, exceptEntry]
    )
  ).rows[0].amount;
}

export function createManualLedger(store, suppliedUser) {
  const mode = store.mode;
  async function actor(c) {
    await c.query('SELECT pg_advisory_xact_lock(17092390)');
    if (!suppliedUser?.id) {
      missing();
    }

    const table = mode === 'demo' ? 'household_demo_users' : 'household_users';
    const user = (
      await c.query(
        `SELECT id,name,role FROM ${table} WHERE id=$1${mode === 'demo' ? '' : ' AND NOT disabled'} FOR SHARE`,
        [suppliedUser.id]
      )
    ).rows[0];
    if (!user) {
      missing();
    }

    return user;
  }

  async function authorized(c, user, ids, edit = false) {
    const unique = [...new Set(ids)];
    if (user.role !== 'admin') {
      const grants = (
        await c.query(
          'SELECT account_id,permission FROM user_account_grants WHERE mode=$1 AND user_id=$2 AND account_id=ANY($3::text[]) FOR SHARE',
          [mode, user.id, unique]
        )
      ).rows;
      if (unique.some((id) => !grants.some((g) => g.account_id === id && (!edit || g.permission === 'edit')))) {
        missing();
      }
    }

    const accounts = (
      await c.query(
        'SELECT * FROM accounts WHERE mode=$1 AND id=ANY($2::text[]) AND deleted_at IS NULL ORDER BY id FOR SHARE',
        [mode, unique]
      )
    ).rows;
    if (accounts.length !== unique.length) {
      missing();
    }

    return accounts;
  }

  function active(accounts) {
    if (accounts.some((account) => account.source_type !== 'manual')) {
      throw domainError('Financial entries can only be written to manual accounts');
    }

    if (accounts.some((account) => account.frozen_at || account.deleted_at)) {
      throw failure('Unfreeze and restore both accounts before changing entries', 409);
    }
  }

  async function command(c, user, request, operation, authorize, work) {
    await authorize();
    const { requestId, ...payload } = request;
    const fingerprint = createHash('sha256')
      .update(JSON.stringify(canonical({ operation, payload })))
      .digest('hex');
    const prior = (
      await c.query(
        'SELECT fingerprint,response FROM manual_commands WHERE mode=$1 AND actor_id=$2 AND request_id=$3',
        [mode, user.id, requestId]
      )
    ).rows[0];
    if (prior) {
      if (prior.fingerprint !== fingerprint) {
        throw failure('This request ID was already used for different values', 409);
      }

      if (prior.response.deleted) {
        throw failure('This request belongs to a permanently deleted account', 409);
      }

      if (
        prior.response.account &&
        (
          await c.query('SELECT 1 FROM accounts WHERE mode=$1 AND id=$2 AND deleted_at IS NOT NULL', [
            mode,
            prior.response.account.id
          ])
        ).rowCount
      ) {
        throw failure('The account was deleted. Restore it from Settings > Data', 409);
      }

      return prior.response;
    }

    const response = await work();
    await c.query(
      'INSERT INTO manual_commands(mode,actor_id,request_id,fingerprint,response,account_ids) VALUES($1,$2,$3,$4,$5,$6)',
      [mode, user.id, requestId, fingerprint, response, response.accounts?.map((a) => a.id) || [response.account.id]]
    );
    return response;
  }

  async function event(c, user, action, before, after, { entryId = null, accountId = null } = {}) {
    await c.query(
      'INSERT INTO manual_events(mode,entry_id,account_id,actor_id,actor_name,action,before_value,after_value) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [mode, entryId, accountId, user.id, user.name, action, before, after]
    );
  }

  async function bump(c, ids) {
    await c.query(
      'UPDATE accounts SET account_revision=account_revision+1,updated_at=clock_timestamp() WHERE mode=$1 AND id=ANY($2::text[])',
      [mode, ids]
    );
  }

  async function entry(c, id) {
    const head = (await c.query('SELECT * FROM manual_entries WHERE mode=$1 AND id=$2', [mode, id])).rows[0];
    if (!head) {
      missing();
    }

    const rows = (
      await c.query(
        `SELECT t.id,t.account_id,t.currency,t.amount_minor::text,t.date,t.description,t.kind,
      COALESCE(o.category,t.classification_category,'Uncategorized') category,COALESCE(o.note,'') note,COALESCE(o.splits,'[]') splits,
      ARRAY(SELECT tag FROM transaction_tags WHERE transaction_id=t.id ORDER BY tag) tags
      FROM transactions t LEFT JOIN transaction_overrides o ON o.transaction_id=t.id
      WHERE t.mode=$1 AND t.manual_entry_id=$2 ORDER BY t.amount_minor,t.id`,
        [mode, id]
      )
    ).rows;
    if (!rows.length) {
      missing();
    }

    return {
      id: head.id,
      type: head.entry_type,
      revision: head.revision,
      voided: !!head.voided_at,
      createdAt: head.created_at,
      updatedAt: head.updated_at,
      transactions: rows.map((row) => ({
        id: row.id,
        accountId: row.account_id,
        currency: row.currency,
        amountMinor: row.amount_minor,
        date: date(row.date),
        description: row.description,
        kind: row.kind,
        category: row.category,
        note: row.note,
        splits: row.splits,
        tags: row.tags
      }))
    };
  }

  async function postedDate(c, accounts, value, type, id = null) {
    if (value > ledgerToday(store)) {
      throw domainError('Manual entries must be dated today or earlier');
    }

    for (const account of accounts) {
      const opening = (
        await c.query('SELECT date FROM transactions WHERE mode=$1 AND manual_entry_id=$2', [
          mode,
          account.opening_entry_id
        ])
      ).rows[0];
      if (type !== 'opening' && opening && value < date(opening.date)) {
        throw domainError('Entry date cannot precede the opening balance');
      }

      if (
        type === 'opening' &&
        (
          await c.query(
            'SELECT 1 FROM transactions WHERE mode=$1 AND account_id=$2 AND voided_at IS NULL AND manual_entry_id<>$3 AND date<$4::date LIMIT 1',
            [mode, account.id, id, value]
          )
        ).rowCount
      ) {
        throw domainError('Opening date cannot move after existing entries');
      }
    }
  }

  async function validateActivity(c, value, previous) {
    const amount = minor(value.amountMinor);
    if ((value.kind === 'expense' && amount >= 0n) || (value.kind !== 'expense' && amount <= 0n)) {
      throw domainError('Expenses need a negative amount; income and refunds need a positive amount');
    }

    await assertCategoryAvailable(store, value.category, previous ? [previous.category] : [], c);
    validateSplits(value.splits, value.amountMinor);
    for (const split of value.splits) {
      await assertCategoryAvailable(
        store,
        split.category,
        (previous?.splits || []).map((row) => row.category),
        c
      );
    }
  }

  async function values(c, input, accounts, previous) {
    await postedDate(c, accounts, input.date, input.type, previous?.id);
    if (input.type === 'activity') {
      await validateActivity(c, input, previous?.transactions[0]);
      return [
        {
          accountId: input.accountId,
          currency: accounts.find((a) => a.id === input.accountId).currency,
          kind: input.kind,
          amountMinor: input.amountMinor,
          date: input.date,
          description: input.description,
          category: input.category,
          note: input.note,
          tags: input.tags,
          splits: input.splits
        }
      ];
    }

    if (input.type === 'transfer') {
      if (input.accountId === input.toAccountId) {
        throw domainError('Choose two distinct manual accounts');
      }

      const from = accounts.find((a) => a.id === input.accountId),
        to = accounts.find((a) => a.id === input.toAccountId);
      if (
        minor(input.amountMinor) <= 0n ||
        minor(input.receivedMinor) <= 0n ||
        (from.currency === to.currency && input.amountMinor !== input.receivedMinor)
      ) {
        throw domainError('Transfer amounts must be positive and equal for the same currency');
      }

      return [
        { accountId: from.id, currency: from.currency, amountMinor: (-minor(input.amountMinor)).toString() },
        { accountId: to.id, currency: to.currency, amountMinor: input.receivedMinor }
      ].map((row) => ({
        ...row,
        kind: 'transfer',
        date: input.date,
        description: 'Transfer between manual accounts',
        category: 'Transfers',
        tags: [],
        note: '',
        splits: []
      }));
    }

    let amountMinor = input.amountMinor;
    if (input.type === 'adjustment' && !previous) {
      if (accounts[0].account_revision !== input.accountRevision) {
        throw failure('The account changed. Reload its balance before adjusting', 409);
      }

      amountMinor = minor(
        (minor(input.targetBalanceMinor) - BigInt(await manualBalance(c, mode, input.accountId, input.date))).toString()
      ).toString();
      if (amountMinor === '0') {
        throw domainError('The balance already matches; no adjustment is needed');
      }
    }

    if (input.type === 'adjustment' && minor(amountMinor) === 0n) {
      throw domainError('An adjustment must change the balance');
    }

    return [
      {
        accountId: input.accountId,
        currency: accounts[0].currency,
        amountMinor,
        date: input.date,
        kind: input.type,
        description: input.type === 'opening' ? 'Opening balance' : 'Balance adjustment',
        category: 'Uncategorized',
        note: input.reason,
        tags: [],
        splits: []
      }
    ];
  }

  async function writeRows(c, id, rows, previous) {
    for (const row of rows) {
      const prior = previous?.transactions.find((item) => item.accountId === row.accountId);
      const transactionId = prior?.id || randomUUID();
      if (prior) {
        await c.query(
          'UPDATE transactions SET amount_minor=$3,date=$4,description=$5,kind=$6,classification_category=$7,fetched_at=clock_timestamp() WHERE mode=$1 AND id=$2',
          [mode, transactionId, row.amountMinor, row.date, row.description, row.kind, row.category]
        );
      } else {
        await c.query(
          `INSERT INTO transactions(id,mode,account_id,currency,amount_minor,status,date,description,classification_category,kind,fetched_at,manual_entry_id)
          VALUES($1,$2,$3,$4,$5,'posted',$6,$7,$8,$9,clock_timestamp(),$10)`,
          [
            transactionId,
            mode,
            row.accountId,
            row.currency,
            row.amountMinor,
            row.date,
            row.description,
            row.category,
            row.kind,
            id
          ]
        );
      }

      await c.query(
        `INSERT INTO transaction_overrides(transaction_id,category,kind,splits,note) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(transaction_id) DO UPDATE SET category=excluded.category,kind=excluded.kind,splits=excluded.splits,note=excluded.note,updated_at=clock_timestamp()`,
        [
          transactionId,
          row.category,
          ['opening', 'adjustment'].includes(row.kind) ? null : row.kind,
          JSON.stringify(row.splits),
          row.note
        ]
      );
      await saveManualTags(c, transactionId, prior?.tags || [], row.tags);
    }
  }

  function sameVersion(prior, revision) {
    if (prior.revision !== revision) {
      throw failure('This entry changed. Reload it before saving', 409);
    }
  }

  async function accountsResult(c, ids) {
    return (await store.listAccounts(c)).filter((account) => ids.includes(account.id));
  }

  return {
    async createAccount(input) {
      const value = manualAccountSchema.parse(input);
      return store.atomic(async (c) => {
        const user = await actor(c);
        if (user.role !== 'admin') {
          throw failure('Administrator access required', 403);
        }

        return command(
          c,
          user,
          value,
          'create-account',
          async () => {},
          async () => {
            if (value.openingDate > ledgerToday(store)) {
              throw domainError('Opening balance must be dated today or earlier');
            }

            const id = `manual_${randomUUID()}`,
              openingId = randomUUID();
            await c.query("INSERT INTO manual_entries(id,mode,entry_type) VALUES($1,$2,'opening')", [openingId, mode]);
            await c.query(
              "INSERT INTO accounts(id,mode,name,description,currency,source_type,opening_entry_id,account_revision) VALUES($1,$2,$3,$4,$5,'manual',$6,1)",
              [id, mode, value.name, value.description, value.currency, openingId]
            );
            await writeRows(c, openingId, [
              {
                accountId: id,
                currency: value.currency,
                amountMinor: value.openingBalanceMinor,
                date: value.openingDate,
                kind: 'opening',
                description: 'Opening balance',
                category: 'Uncategorized',
                tags: [],
                splits: [],
                note: 'Initial opening balance'
              }
            ]);
            const opening = await entry(c, openingId),
              account = (await accountsResult(c, [id]))[0];
            await event(c, user, 'account-created', null, account, { accountId: id });
            await event(c, user, 'entry-created', null, opening, { entryId: openingId });
            return { account, entry: opening };
          }
        );
      });
    },
    async createEntry(input) {
      const value = manualEntrySchema.parse(input);
      return store.atomic(async (c) => {
        const user = await actor(c),
          ids = [value.accountId, ...(value.type === 'transfer' ? [value.toAccountId] : [])];
        const accounts = await authorized(c, user, ids, true);
        active(accounts);
        return command(
          c,
          user,
          value,
          'create-entry',
          async () => {},
          async () => {
            active(accounts);
            const rows = await values(c, value, accounts);
            const id = randomUUID();
            await c.query('INSERT INTO manual_entries(id,mode,entry_type) VALUES($1,$2,$3)', [id, mode, value.type]);
            await writeRows(c, id, rows);
            await bump(c, ids);
            const saved = await entry(c, id);
            await event(c, user, 'entry-created', null, saved, { entryId: id });
            return { entry: saved, accounts: await accountsResult(c, ids) };
          }
        );
      });
    },
    async editEntry(id, input) {
      const value = manualEditSchema.parse(input);
      return store.atomic(async (c) => {
        const user = await actor(c),
          prior = await entry(c, id),
          ids = prior.transactions.map((row) => row.accountId);
        const accounts = await authorized(c, user, ids, true);
        active(accounts);
        return command(
          c,
          user,
          value,
          `edit-entry:${id}`,
          async () => {},
          async () => {
            active(accounts);
            sameVersion(prior, value.revision);
            if (prior.voided) {
              throw failure('Voided entries cannot be changed', 409);
            }

            if (
              prior.type !== value.type ||
              !ids.includes(value.accountId) ||
              (value.type === 'transfer' &&
                (!ids.includes(value.toAccountId) ||
                  prior.transactions.find((row) => row.accountId === value.accountId).amountMinor[0] !== '-'))
            ) {
              throw domainError('Entry type and accounts cannot be changed; void it and create a new entry');
            }

            const rows = await values(c, value, accounts, prior);
            await writeRows(c, id, rows, prior);
            await c.query(
              'UPDATE manual_entries SET revision=revision+1,updated_at=clock_timestamp() WHERE mode=$1 AND id=$2',
              [mode, id]
            );
            await bump(c, ids);
            const saved = await entry(c, id);
            await event(c, user, 'entry-edited', prior, saved, { entryId: id });
            return { entry: saved, accounts: await accountsResult(c, ids) };
          }
        );
      });
    },
    async voidEntry(id, input) {
      const value = manualVoidSchema.parse(input);
      return store.atomic(async (c) => {
        const user = await actor(c),
          prior = await entry(c, id),
          ids = prior.transactions.map((row) => row.accountId);
        const accounts = await authorized(c, user, ids, true);
        active(accounts);
        return command(
          c,
          user,
          value,
          `void-entry:${id}`,
          async () => {},
          async () => {
            active(accounts);
            sameVersion(prior, value.revision);
            if (prior.type === 'opening') {
              throw domainError('Opening balances cannot be voided. Correct the opening balance instead');
            }

            if (!prior.voided) {
              await c.query(
                'UPDATE transactions SET voided_at=clock_timestamp() WHERE mode=$1 AND manual_entry_id=$2',
                [mode, id]
              );
              await c.query(
                'UPDATE manual_entries SET voided_at=clock_timestamp(),updated_at=clock_timestamp(),revision=revision+1 WHERE mode=$1 AND id=$2',
                [mode, id]
              );
              await bump(c, ids);
              await event(
                c,
                user,
                'entry-voided',
                prior,
                { ...(await entry(c, id)), reason: value.reason },
                { entryId: id }
              );
            }

            return { entry: await entry(c, id), accounts: await accountsResult(c, ids) };
          }
        );
      });
    },
    async getEntry(id) {
      return store.atomic(
        async (c) => {
          const user = await actor(c),
            result = await entry(c, id);
          await authorized(
            c,
            user,
            result.transactions.map((row) => row.accountId)
          );
          const audit = (
            await c.query(
              'SELECT action,actor_id,actor_name,before_value,after_value,created_at FROM manual_events WHERE mode=$1 AND entry_id=$2 ORDER BY id',
              [mode, id]
            )
          ).rows;
          return { entry: result, audit };
        },
        { refresh: false }
      );
    }
  };
}
