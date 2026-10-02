import { createHash } from 'node:crypto';
import {
  pocketSmithTagPlan,
  normalizePocketSmithAccount,
  normalizePocketSmithTransaction
} from './pocketsmith-data.mjs';

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (code) => {
  throw Object.assign(new Error(`pocketsmith_${code}`), { code: `pocketsmith_${code}` });
};

async function categoryKey(c, userId, category) {
  if (!category) {
    return null;
  }

  const key = `pscat_${hash([userId, category.remoteId])}`;
  const before = (
    await c.query('SELECT provider_name FROM pocketsmith_categories WHERE user_id=$1 AND native_id=$2', [
      userId,
      category.remoteId
    ])
  ).rows[0];
  await c.query(
    `INSERT INTO category_catalog(mode,category,name,shared) VALUES('live',$1,$2,false)
    ON CONFLICT(mode,category) DO UPDATE SET name=excluded.name
    WHERE category_catalog.name=$3 AND NOT EXISTS(SELECT 1 FROM audit_history WHERE mode='live' AND action='category-settings' AND after_value->>'category'=$1)`,
    [key, category.name, before?.provider_name || category.name]
  );
  await c.query(
    `INSERT INTO pocketsmith_categories(user_id,native_id,category,provider_name) VALUES($1,$2,$3,$4)
    ON CONFLICT(user_id,native_id) DO UPDATE SET provider_name=excluded.provider_name`,
    [userId, category.remoteId, key, category.name]
  );
  return key;
}

export function preparePocketSmithImport(rawAccount, batches, source, fetchedAt) {
  const account = normalizePocketSmithAccount(rawAccount, {
    userId: source.user_id,
    fetchedAt,
    group: source.metadata.group
  });
  if (
    account.id !== source.local_id ||
    account.remoteId !== source.native_id ||
    account.currency !== source.metadata.currency
  ) {
    fail('account_identity_changed');
  }

  const transactions = batches.flatMap((batch) =>
    batch.records.map((raw) => ({
      ...normalizePocketSmithTransaction(raw, account, { fetchedAt }),
      raw
    }))
  );
  // Validate every page before any database mutation. Preserve the response
  // evidence separately, so rejected/stale canonical versions cannot overwrite it.
  return { account, transactions, rawAccount, batches, fetchedAt };
}

export async function applyPocketSmithImport(c, store, prepared) {
  const { account, transactions, rawAccount, batches, fetchedAt } = prepared;
  if ((await c.query("SELECT 1 FROM account_tombstones WHERE mode='live' AND account_id=$1", [account.id])).rowCount) {
    return false;
  }

  const before = (await c.query('SELECT metadata FROM pocketsmith_accounts WHERE local_id=$1', [account.id])).rows[0];
  if (!before) {
    return false;
  }

  const prior = before.metadata;
  // A newer fetch of an older bank balance does not make that balance current.
  const balanceStale = prior.balanceDate && (!account.balanceDate || account.balanceDate < prior.balanceDate);
  const effective = balanceStale
    ? {
        ...account,
        balanceMinor: prior.balanceMinor,
        balanceDate: prior.balanceDate,
        balanceMetadata: prior.balanceMetadata,
        balanceAt: null
      }
    : account;
  await store.updateAccount(
    effective,
    {
      source: 'pocketsmith',
      sourceAccountId: account.remoteId,
      group: account.group,
      balanceDate: effective.balanceDate,
      balanceMetadata: effective.balanceMetadata,
      reason:
        'Provider-reported records only; missing records never imply deletion. Balance date is provider-selected, not a bank sync timestamp.'
    },
    c
  );
  for (const batch of batches) {
    await c.query(
      `INSERT INTO pocketsmith_fetches(account_id,fetched_at,query,account_evidence,pages) VALUES($1,$2,$3,$4,$5)`,
      [account.id, fetchedAt, batch.query, rawAccount, JSON.stringify(batch.pages)]
    );
  }

  for (const item of transactions) {
    const { observation, category, tags, sourceUpdatedAt, raw } = item;
    const { fetchedAt: _fetched, reviewReason: _review, ...financial } = observation;
    const fingerprint = hash({ financial, categoryId: category?.remoteId || null, tags });
    const version = (
      await c.query(
        `SELECT fingerprint,updated_at < $3::timestamptz older,updated_at > $3::timestamptz newer
      FROM pocketsmith_versions WHERE account_id=$1 AND source_id=$2`,
        [account.id, observation.sourceId, sourceUpdatedAt]
      )
    ).rows[0];
    if (version?.newer) {
      continue;
    }

    if (version && !version.older && version.fingerprint !== fingerprint) {
      fail('conflicting_source_version');
    }

    const localCategory = await categoryKey(c, account.userId, item.category);
    const result = await store._ingest(c, { ...observation, category: localCategory, raw, sourceUpdatedAt });
    if (!result) {
      continue;
    }

    const preferences = (
      await c.query('SELECT tag,removed FROM transaction_tag_preferences WHERE transaction_id=$1', [result.id])
    ).rows;
    const current = (
      await c.query('SELECT tag FROM transaction_tags WHERE transaction_id=$1 ORDER BY tag', [result.id])
    ).rows.map((r) => r.tag);
    const plan = pocketSmithTagPlan(tags, current, preferences);
    if (plan.added.length) {
      await c.query(
        'INSERT INTO transaction_tags(transaction_id,tag) SELECT $1,unnest($2::text[]) ON CONFLICT DO NOTHING',
        [result.id, plan.added]
      );
      await c.query(
        "INSERT INTO audit_history(mode,transaction_id,action,before_value,after_value) VALUES('live',$1,'pocketsmith-tags-added',$2,$3)",
        [result.id, { tags: current }, { tags: plan.tags, added: plan.added }]
      );
    }

    await c.query(
      `INSERT INTO pocketsmith_versions(account_id,source_id,updated_at,fingerprint) VALUES($1,$2,$3,$4)
      ON CONFLICT(account_id,source_id) DO UPDATE SET updated_at=excluded.updated_at,fingerprint=excluded.fingerprint`,
      [account.id, observation.sourceId, sourceUpdatedAt, fingerprint]
    );
  }

  await c.query('UPDATE pocketsmith_accounts SET metadata=$2 WHERE local_id=$1', [account.id, effective]);
  await store.refreshAlerts(c);
  return true;
}
