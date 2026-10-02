import { createHash } from 'node:crypto';
import { accountLifecycleSchema, accountPurgeSelection, accountPurgeSchema } from './manual-schemas.mjs';
import { bumpAccessRevision } from './access.mjs';
const fail = (message, status = 400) => {
  throw Object.assign(Error(message), { status });
};

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function createAccountLifecycle(store, principal) {
  const mode = store.mode;
  async function actor(c, admin = false) {
    await c.query('SELECT pg_advisory_xact_lock(17092390)');
    const table = mode === 'demo' ? 'household_demo_users' : 'household_users';
    const user = (
      await c.query(`SELECT id,role FROM ${table} WHERE id=$1${mode === 'live' ? ' AND NOT disabled' : ''}`, [
        principal?.id
      ])
    ).rows[0];
    if (!user) {
      fail('Not found', 404);
    }

    if (admin && user.role !== 'admin') {
      fail('Administrator access required', 403);
    }

    return user;
  }

  async function account(c, user, id) {
    if (
      user.role !== 'admin' &&
      !(
        await c.query(
          "SELECT 1 FROM user_account_grants WHERE mode=$1 AND user_id=$2 AND account_id=$3 AND permission='edit'",
          [mode, user.id, id]
        )
      ).rowCount
    ) {
      fail('Not found', 404);
    }

    const a = (await c.query('SELECT * FROM accounts WHERE mode=$1 AND id=$2 FOR UPDATE', [mode, id])).rows[0];
    if (!a || (a.deleted_at && user.role !== 'admin')) {
      fail('Not found', 404);
    }

    return a;
  }

  async function audit(c, user, id, action, details) {
    await c.query(
      'INSERT INTO account_lifecycle_events(mode,account_id,actor_id,action,details) VALUES($1,$2,$3,$4,$5)',
      [mode, id, user.id, action, details]
    );
  }

  async function invalidate(c) {
    // Lifecycle changes affect granted budget totals and retained assistant context too.
    const table = mode === 'demo' ? 'household_demo_users' : 'household_users';
    for (const row of (await c.query(`SELECT id FROM ${table}`)).rows) {
      await bumpAccessRevision(c, row.id, { mode });
    }
  }

  async function command(c, user, value, operation, work, ids) {
    const fingerprint = digest({ operation, value });
    const prior = (
      await c.query(
        'SELECT fingerprint,response FROM manual_commands WHERE mode=$1 AND actor_id=$2 AND request_id=$3',
        [mode, user.id, value.requestId]
      )
    ).rows[0];
    if (prior) {
      if (prior.fingerprint !== fingerprint) {
        fail('Request ID already used for different values', 409);
      }

      if (prior.response.deleted) {
        fail('This request belongs to a permanently deleted account', 409);
      }

      return prior.response;
    }

    const result = await work();
    await c.query(
      'INSERT INTO manual_commands(mode,actor_id,request_id,fingerprint,response,account_ids) VALUES($1,$2,$3,$4,$5,$6)',
      [mode, user.id, value.requestId, fingerprint, result, ids]
    );
    return result;
  }

  async function preview(c, ids) {
    ids = [...new Set(ids)].sort();
    const accounts = (
      await c.query(
        'SELECT id,COALESCE(local_label,name) name,source_type,deleted_at,account_revision FROM accounts WHERE mode=$1 AND id=ANY($2) ORDER BY id',
        [mode, ids]
      )
    ).rows;
    if (accounts.length !== ids.length) {
      fail('Not found', 404);
    }

    if (accounts.some((a) => !a.deleted_at)) {
      fail('Soft-delete every selected account before permanent deletion', 409);
    }

    const transactions = (
      await c.query('SELECT * FROM transactions WHERE mode=$1 AND account_id=ANY($2) ORDER BY id', [mode, ids])
    ).rows;
    const entryIds = [...new Set(transactions.map((t) => t.manual_entry_id).filter(Boolean))].sort();
    const linked = (
      await c.query(
        `SELECT DISTINCT a.id,COALESCE(a.local_label,a.name) name FROM transactions t JOIN accounts a ON a.mode=t.mode AND a.id=t.account_id WHERE t.mode=$1 AND NOT t.account_id=ANY($2) AND (t.manual_entry_id=ANY($3::uuid[]) OR t.superseded_by=ANY($4::uuid[])) ORDER BY a.id`,
        [mode, ids, entryIds, transactions.map((t) => t.id)]
      )
    ).rows;
    const counts = {};
    const txIds = transactions.map((t) => t.id);
    for (const table of [
      'provider_observations',
      'source_aliases',
      'transaction_overrides',
      'transaction_tags',
      'transaction_tag_preferences',
      'audit_history'
    ]) {
      counts[table] = Number(
        (await c.query(`SELECT count(*) FROM ${table} WHERE transaction_id=ANY($1::uuid[])`, [txIds])).rows[0].count
      );
    }

    if ((await c.query("SELECT to_regclass('classification_jobs') name")).rows[0].name) {
      counts.classification_jobs = Number(
        (
          await c.query('SELECT count(*) FROM classification_jobs WHERE mode=$1 AND transaction_id=ANY($2::text[])', [
            mode,
            txIds
          ])
        ).rows[0].count
      );
    }

    if (mode === 'live' && (await c.query("SELECT to_regclass('redbark_fetches') name")).rows[0].name) {
      counts.redbark_fetches = Number(
        (await c.query('SELECT count(*) FROM redbark_fetches WHERE account_id=ANY($1)', [ids])).rows[0].count
      );
    }

    counts.account_grants = Number(
      (await c.query('SELECT count(*) FROM user_account_grants WHERE mode=$1 AND account_id=ANY($2)', [mode, ids]))
        .rows[0].count
    );
    counts.redacted_command_receipts = Number(
      (await c.query('SELECT count(*) FROM manual_commands WHERE mode=$1 AND account_ids && $2::text[]', [mode, ids]))
        .rows[0].count
    );
    counts.account_settings_audit = Number(
      (
        await c.query(
          "SELECT count(*) FROM audit_history WHERE mode=$1 AND (before_value->>'accountId'=ANY($2) OR after_value->>'accountId'=ANY($2))",
          [mode, ids]
        )
      ).rows[0].count
    );
    if (counts.redbark_fetches !== undefined) {
      counts.redbark_jobs = Number(
        (await c.query("SELECT count(*) FROM redbark_jobs WHERE params->>'accountId'=ANY($1)", [ids])).rows[0].count
      );
    }

    counts.transactions = transactions.length;
    counts.manual_entries = entryIds.length;
    counts.manual_events = Number(
      (
        await c.query(
          'SELECT count(*) FROM manual_events WHERE mode=$1 AND (account_id=ANY($2) OR entry_id=ANY($3::uuid[]))',
          [mode, ids, entryIds]
        )
      ).rows[0].count
    );
    counts.simplefin_fetches = Number(
      (
        await c.query(
          "SELECT count(*) FROM simplefin_fetches f JOIN simplefin_accounts a USING(source_id,remote_key) WHERE $1='live' AND a.local_id=ANY($2)",
          [mode, ids]
        )
      ).rows[0].count
    );
    const data = {
      accounts,
      counts,
      linkedAccounts: linked,
      confirmation: `DELETE ${ids.length} ACCOUNT${ids.length === 1 ? '' : 'S'} PERMANENTLY`
    };
    // Include records, overrides and evidence identity in freshness, not just visible counts.
    const evidence = (
      await c.query(
        'SELECT id,fingerprint FROM provider_observations WHERE mode=$1 AND account_id=ANY($2) ORDER BY id',
        [mode, ids]
      )
    ).rows;
    const corrections = (
      await c.query(
        'SELECT * FROM transaction_overrides WHERE transaction_id=ANY($1::uuid[]) ORDER BY transaction_id',
        [txIds]
      )
    ).rows;
    return { ...data, previewToken: digest({ data, transactions, evidence, corrections }), entryIds, txIds };
  }

  const publicPreview = ({ entryIds: _entryIds, txIds: _txIds, ...result }) => result;
  return {
    listDeleted: () =>
      store.atomic(
        async (c) => {
          await actor(c, true);
          return { accounts: await store.listAccounts(c, { deleted: true }) };
        },
        { refresh: false }
      ),
    change: (id, input) => {
      const value = accountLifecycleSchema.parse(input);
      return store.atomic(async (c) => {
        const user = await actor(c, value.action === 'restore');
        const a = await account(c, user, id);
        return command(
          c,
          user,
          value,
          `${id}:${value.action}`,
          async () => {
            if (a.account_revision !== value.revision) {
              fail('Account changed. Reload before continuing', 409);
            }

            if (a.deleted_at && value.action !== 'restore') {
              fail('Restore the account first', 409);
            }

            if (!a.deleted_at && value.action === 'restore') {
              fail('Account is not deleted', 409);
            }

            const column = ['freeze', 'unfreeze'].includes(value.action) ? 'frozen_at' : 'deleted_at';
            const set = ['freeze', 'delete'].includes(value.action);
            await c.query(
              `UPDATE accounts SET ${column}=${set ? 'clock_timestamp()' : 'NULL'},account_revision=account_revision+1,updated_at=clock_timestamp() WHERE mode=$1 AND id=$2`,
              [mode, id]
            );
            await audit(c, user, id, value.action, {
              reason: value.reason,
              previousRevision: a.account_revision,
              reportsHidden: value.action === 'delete'
            });
            await invalidate(c);
            return { changed: true };
          },
          [id]
        );
      });
    },
    preview: (input) => {
      const { accountIds } = accountPurgeSelection.parse(input);
      return store.atomic(
        async (c) => {
          await actor(c, true);
          return publicPreview(await preview(c, accountIds));
        },
        { refresh: false }
      );
    },
    purge: (input) => {
      const value = accountPurgeSchema.parse(input);
      return store.atomic(async (c) => {
        const user = await actor(c, true);
        return command(
          c,
          user,
          value,
          'purge',
          async () => {
            const p = await preview(c, value.accountIds),
              ids = p.accounts.map((a) => a.id);
            if (value.previewToken !== p.previewToken || value.confirmation !== p.confirmation) {
              fail('Preview changed or confirmation does not match. Review a new preview', 409);
            }

            if (p.linkedAccounts.length) {
              fail('Linked transfers require all linked accounts to be soft-deleted and selected together', 409);
            }

            await c.query(
              "SELECT set_config('dolphino.purge_mode',$1,true),set_config('dolphino.purge_accounts',$2,true)",
              [mode, ids.join(',')]
            );
            await invalidate(c);
            for (const id of ids) {
              await audit(c, user, id, 'permanently-deleted', {
                counts: p.counts,
                sourceType: p.accounts.find((a) => a.id === id).source_type
              });
            }

            await c.query(
              'DELETE FROM manual_events WHERE mode=$1 AND (account_id=ANY($2) OR entry_id=ANY($3::uuid[]))',
              [mode, ids, p.entryIds]
            );
            if (mode === 'live') {
              await c.query(
                'DELETE FROM simplefin_fetches f USING simplefin_accounts a WHERE f.source_id=a.source_id AND f.remote_key=a.remote_key AND a.local_id=ANY($1)',
                [ids]
              );
              await c.query(
                'DELETE FROM simplefin_jobs j USING simplefin_accounts a WHERE j.source_id=a.source_id AND j.remote_key=a.remote_key AND a.local_id=ANY($1)',
                [ids]
              );
              await c.query(
                "UPDATE simplefin_accounts SET metadata='{}',last_success=NULL,mapped_at=NULL WHERE local_id=ANY($1)",
                [ids]
              );
              // Keep only hashed remote/source identity reservations; polling checks tombstones.
            }

            for (const table of [
              'provider_observations',
              'source_aliases',
              'transaction_overrides',
              'transaction_tags',
              'transaction_tag_preferences',
              'audit_history'
            ]) {
              await c.query(`DELETE FROM ${table} WHERE transaction_id=ANY($1::uuid[])`, [p.txIds]);
            }

            await c.query(
              "DELETE FROM audit_history WHERE mode=$1 AND (before_value->>'accountId'=ANY($2) OR after_value->>'accountId'=ANY($2))",
              [mode, ids]
            );
            await c.query(
              "UPDATE manual_commands SET response='{\"deleted\":true}',account_ids='{}' WHERE mode=$1 AND account_ids && $2::text[]",
              [mode, ids]
            );
            if (p.counts.redbark_fetches !== undefined) {
              await c.query('DELETE FROM redbark_fetches WHERE account_id=ANY($1)', [ids]);
              await c.query("DELETE FROM redbark_jobs WHERE params->>'accountId'=ANY($1)", [ids]);
            }

            if (p.counts.classification_jobs !== undefined) {
              await c.query('DELETE FROM classification_jobs WHERE mode=$1 AND transaction_id=ANY($2::text[])', [
                mode,
                p.txIds
              ]);
            }

            await c.query('DELETE FROM transactions WHERE mode=$1 AND account_id=ANY($2)', [mode, ids]);
            await c.query(
              'INSERT INTO account_tombstones(mode,account_id,source_type) SELECT mode,id,source_type FROM accounts WHERE mode=$1 AND id=ANY($2)',
              [mode, ids]
            );
            await c.query('DELETE FROM accounts WHERE mode=$1 AND id=ANY($2)', [mode, ids]);
            await c.query('DELETE FROM manual_entries WHERE mode=$1 AND id=ANY($2::uuid[])', [mode, p.entryIds]);
            return { deletedAccountIds: ids, counts: p.counts };
          },
          []
        );
      });
    }
  };
}
