import { z } from 'zod';

const categorySchema = z.object({
  id: z.string().regex(/^cat_[A-Za-z0-9]+$/),
  name: z.string().trim().min(1).max(100)
});

export const isRedbarkCategoryReference = (value) => typeof value === 'string' && value.startsWith('cat_');
export const isKnownCategoryLabel = (value) =>
  typeof value === 'string' && !!value.trim() && value !== 'Uncategorized' && !isRedbarkCategoryReference(value);

// Presentation metadata never changes a category key used by budgets or filters.
export function categoryDisplayMetadata(category, references = []) {
  return isRedbarkCategoryReference(category) && references.includes(category)
    ? { categoryDisplayLabel: 'Unresolved category' }
    : {};
}

export const transactionCategoryReferencesSql = `ARRAY(
  SELECT DISTINCT p.payload->'raw'->>'category' FROM provider_observations p
  WHERE p.mode=t.mode AND p.transaction_id=t.id AND p.account_id=t.account_id AND p.provider='redbark'
    AND p.payload->'raw'->>'category' LIKE 'cat\\_%' ESCAPE '\\'
)`;

export function redbarkCategoryNames(rows) {
  const names = new Map();
  for (const row of z.array(categorySchema).parse(rows)) {
    if (isRedbarkCategoryReference(row.name) || (names.has(row.id) && names.get(row.id) !== row.name)) {
      throw new Error('invalid_provider_categories');
    }
    names.set(row.id, row.name);
  }
  return names;
}

// A v2 category is a taxonomy reference, never a label or evidence of financial kind.
// Keep the reference and provider vocabulary in the immutable raw observation.
export function resolveRedbarkCategory(raw, names = new Map()) {
  if (isRedbarkCategoryReference(raw.category)) {
    return names.get(raw.category);
  }
  return raw.category || raw.provider_category || undefined;
}
