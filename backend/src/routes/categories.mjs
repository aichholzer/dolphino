import { z } from 'zod';
import { body } from '../http/body.mjs';
import { categoryName, changeCategory } from '../lib/category-catalog.mjs';

export function registerCategoryRoutes({ route, store, ledger }) {
  route(
    'get',
    '/api/categories',
    async (req) => {
      const catalog = await ledger(req).listCategoryCatalog();
      return { catalog, categories: catalog.filter((entry) => !entry.archived).map((entry) => entry.category) };
    },
    { access: 'financial' }
  );
  route('get', '/api/tags', async (req) => ({ tags: await ledger(req).listTags() }), { access: 'financial' });
  route('get', '/api/settings/categories', async () => ({ catalog: await store.listCategoryCatalog() }));
  route('post', '/api/settings/categories', async (req) => {
    const { name } = z
      .object({ name: categoryName })
      .strict()
      .parse(await body(req));
    return changeCategory(store, { name, create: true });
  });
  route('patch', '/api/settings/categories', async (req) => {
    const value = z
      .object({ category: categoryName, name: categoryName.optional(), archived: z.boolean().optional() })
      .strict()
      .refine((value) => value.name !== undefined || value.archived !== undefined)
      .parse(await body(req));
    return changeCategory(store, value);
  });
  route('delete', '/api/settings/categories', async (req) => {
    const { category } = z
      .object({ category: categoryName })
      .strict()
      .parse(await body(req));
    return changeCategory(store, { category, archived: true });
  });
}
