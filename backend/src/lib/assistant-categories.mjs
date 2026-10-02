const normalized = (text) =>
  text
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, ' ');
// These are candidate matches, never permission grants or invented category keys.
const dining = new Set(['eating out', 'dining out', 'dining', 'restaurants', 'restaurant', 'restaurants and cafes']);
export function categoryMatches(catalog, query) {
  if (!query) {
    return catalog;
  }

  const value = normalized(query);
  const exact = catalog.filter((entry) => [entry.category, entry.name].some((text) => normalized(text) === value));
  if (exact.length) {
    return exact;
  }

  return dining.has(value) ? catalog.filter((entry) => dining.has(normalized(entry.name))) : [];
}

export async function assistantCategories(finance) {
  const catalog = await finance.listCategoryCatalog();
  return catalog.map(({ category, name, archived }) => ({ category, name, archived: !!archived }));
}
