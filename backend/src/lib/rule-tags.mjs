import { createHash } from 'node:crypto';
import { domainError, matchingRule } from './engine.mjs';

// A deterministic UUID (version 8) makes first-match tie ordering identical in
// preview and save without persisting previews or changing existing rule IDs.
export function newRuleId(mode, contains) {
  const bytes = createHash('sha256')
    .update(JSON.stringify(['dolphino-rule', mode, contains]))
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 128;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function ruleTagPlan(description, rules, current, preferences) {
  const rule = matchingRule(description, rules);
  const excluded = new Set(preferences.filter((row) => row.removed).map((row) => row.tag));
  const candidates = (rule?.tags || []).filter((tag) => !current.includes(tag));
  const permitted = candidates.filter((tag) => !excluded.has(tag));
  const added = permitted.slice(0, Math.max(0, 20 - current.length));
  return {
    ruleId: rule?.id || null,
    added,
    suppressed: candidates.filter((tag) => excluded.has(tag)),
    capacitySkipped: permitted.slice(added.length),
    tags: [...current, ...added].sort()
  };
}

export async function applyRuleTags(c, mode, transaction, rules) {
  if (transaction.superseded_by || !matchingRule(transaction.description, rules)?.tags?.length) {
    return;
  }

  const current = (
    await c.query('SELECT tag FROM transaction_tags WHERE transaction_id=$1 ORDER BY tag', [transaction.id])
  ).rows.map((row) => row.tag);
  const preferences = (
    await c.query('SELECT tag,removed FROM transaction_tag_preferences WHERE transaction_id=$1', [transaction.id])
  ).rows;
  const plan = ruleTagPlan(transaction.description, rules, current, preferences);
  if (!plan.added.length) {
    return;
  }

  await c.query(
    'INSERT INTO transaction_tags(transaction_id,tag) SELECT $1,unnest($2::text[]) ON CONFLICT DO NOTHING',
    [transaction.id, plan.added]
  );
  await c.query(
    "INSERT INTO audit_history(mode,transaction_id,action,before_value,after_value) VALUES($1,$2,'rule-tags-added',$3,$4)",
    [mode, transaction.id, { tags: current }, { tags: plan.tags, ruleId: plan.ruleId, added: plan.added }]
  );
}

export async function saveManualTags(c, id, before, after) {
  const changed = [...new Set([...before, ...after])].filter((tag) => before.includes(tag) !== after.includes(tag));
  for (const tag of changed) {
    await c.query(
      `INSERT INTO transaction_tag_preferences(transaction_id,tag,removed) VALUES($1,$2,$3)
      ON CONFLICT(transaction_id,tag) DO UPDATE SET removed=excluded.removed,updated_at=clock_timestamp()`,
      [id, tag, !after.includes(tag)]
    );
  }

  await c.query('DELETE FROM transaction_tags WHERE transaction_id=$1', [id]);
  await c.query('INSERT INTO transaction_tags(transaction_id,tag) SELECT $1,unnest($2::text[])', [id, after]);
}

export async function mergeTransactionTags(c, postedId, pendingId) {
  const ids = [postedId, pendingId];
  const preferences = (
    await c.query(
      `SELECT DISTINCT ON (p.tag) p.tag,p.removed,p.updated_at::text updated_at FROM transaction_tag_preferences p
    WHERE p.transaction_id=ANY($1::uuid[]) ORDER BY p.tag,p.updated_at DESC,(p.transaction_id=$2) DESC`,
      [ids, postedId]
    )
  ).rows;
  const combined = new Set(
    (await c.query('SELECT DISTINCT tag FROM transaction_tags WHERE transaction_id=ANY($1::uuid[])', [ids])).rows.map(
      (row) => row.tag
    )
  );
  for (const preference of preferences) {
    if (preference.removed) {
      combined.delete(preference.tag);
    } else {
      combined.add(preference.tag);
    }
  }

  if (combined.size > 20) {
    throw domainError('The linked transaction would exceed 20 tags. Remove unused tags before linking.');
  }

  await c.query('DELETE FROM transaction_tags WHERE transaction_id=$1', [postedId]);
  await c.query('INSERT INTO transaction_tags(transaction_id,tag) SELECT $1,unnest($2::text[])', [
    postedId,
    [...combined].sort()
  ]);
  for (const preference of preferences) {
    await c.query(
      `INSERT INTO transaction_tag_preferences(transaction_id,tag,removed,updated_at) VALUES($1,$2,$3,$4)
      ON CONFLICT(transaction_id,tag) DO UPDATE SET removed=excluded.removed,updated_at=excluded.updated_at`,
      [postedId, preference.tag, preference.removed, preference.updated_at]
    );
  }
}
