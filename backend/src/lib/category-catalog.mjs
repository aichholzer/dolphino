import { z } from 'zod';
import { domainError } from './engine.mjs';

export const categoryName = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine((name) => !name.startsWith('cat_') && !/[\p{Cc}\p{Cf}]/u.test(name), 'Choose a readable category name');

export const tagsSchema = z
  .array(
    z
      .string()
      .trim()
      .min(1)
      .max(40)
      .refine((tag) => !/[\p{Cc}\p{Cf}]/u.test(tag))
      .transform((tag) => tag.toLowerCase())
  )
  .max(20)
  .transform((tags) => [...new Set(tags)].sort());

export const effectiveCategorySql =
  "COALESCE(o.category,NULLIF(t.classification_category,'Uncategorized'),t.ai_category,t.provider_category,'Uncategorized')";

export const transferSql = "(COALESCE(o.kind='transfer',false) OR t.kind='transfer')";

// Imported/user categories are derived only from permitted records. Shared catalog
// entries are administrator-authored vocabulary, never usage counts or account metadata.
export async function categoryCatalog(store, c = store.pool, scope = {}) {
  const { accountIds, budgetIds = [], admin = accountIds === undefined } = scope;
  const result = await c.query(
    `WITH visible AS (
    SELECT ${effectiveCategorySql} category,o.splits,t.provider_category
    FROM transactions t LEFT JOIN transaction_overrides o ON o.transaction_id=t.id
    WHERE t.mode=$1 AND t.superseded_by IS NULL AND ($2::boolean OR t.account_id=ANY($3::text[]))
      AND ($2::boolean OR NOT ${transferSql})
  ), keys AS (
    SELECT category FROM visible UNION SELECT provider_category FROM visible
    UNION SELECT split->>'category' FROM visible,jsonb_array_elements(COALESCE(splits,'[]'::jsonb)) split
    UNION SELECT category FROM budgets WHERE mode=$1 AND ($2 OR id=ANY($4::uuid[]))
    UNION SELECT category FROM rules WHERE mode=$1 AND $2
    UNION SELECT category FROM category_catalog WHERE mode=$1 AND ($2 OR shared)
    UNION SELECT 'Transfers' WHERE NOT $2 AND EXISTS(
      SELECT 1 FROM transactions t LEFT JOIN transaction_overrides o ON o.transaction_id=t.id
      WHERE t.mode=$1 AND t.superseded_by IS NULL AND t.account_id=ANY($3::text[]) AND ${transferSql})
  ) SELECT k.category,
    CASE WHEN NOT $2 AND k.category='Transfers' THEN 'Transfers' ELSE COALESCE(c.name,k.category) END name,
    CASE WHEN NOT $2 AND k.category='Transfers' THEN false ELSE COALESCE(c.archived,false) END archived
    FROM keys k LEFT JOIN category_catalog c ON c.mode=$1 AND c.category=k.category
    WHERE length(k.category) BETWEEN 1 AND 100 AND k.category NOT LIKE 'cat\\_%' ESCAPE '\\'
    ORDER BY lower(CASE WHEN NOT $2 AND k.category='Transfers' THEN 'Transfers' ELSE COALESCE(c.name,k.category) END),k.category`,
    [store.mode, admin, accountIds || [], budgetIds]
  );
  return result.rows;
}

export async function changeCategory(store, { category, name, archived, create = false }) {
  if (name !== undefined) {
    name = categoryName.parse(name);
  }

  return store.atomic(async (c) => {
    const catalog = await categoryCatalog(store, c);
    const before = catalog.find((entry) => entry.category === category);
    if (!create && !before) {
      throw Object.assign(Error('Category not found'), { status: 404 });
    }

    if (category === 'Uncategorized' && (archived || (name && name !== category))) {
      throw domainError('Uncategorized is the fallback category and cannot be renamed or archived');
    }

    if (
      name &&
      catalog.some(
        (entry) =>
          (create || entry.category !== category) &&
          [entry.name, entry.category].some((value) => value.toLowerCase() === name.toLowerCase())
      )
    ) {
      throw Object.assign(Error('That category already exists. Choose another name or restore it.'), { status: 409 });
    }

    const after = (
      await c.query(
        `INSERT INTO category_catalog(mode,category,name,archived,shared)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(mode,category) DO UPDATE
      SET name=excluded.name,archived=excluded.archived RETURNING category,name,archived`,
        [store.mode, create ? name : category, name ?? before.name, archived ?? before?.archived ?? false, create]
      )
    ).rows[0];
    await c.query(
      "INSERT INTO audit_history(mode,action,before_value,after_value) VALUES($1,'category-settings',$2,$3)",
      [store.mode, before || null, after]
    );
    return after;
  });
}

export async function assertCategoryAvailable(store, category, previous, c) {
  if (category === undefined || previous.includes(category)) {
    return;
  }

  const row = (
    await c.query('SELECT archived FROM category_catalog WHERE mode=$1 AND category=$2', [store.mode, category])
  ).rows[0];
  if (row?.archived) {
    throw domainError('This category is archived. Choose an active category.');
  }
}
