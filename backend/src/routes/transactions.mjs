import { z } from 'zod';
import { createAccessStore } from '../lib/access.mjs';
import { body } from '../http/body.mjs';
import { tagsSchema } from '../lib/category-catalog.mjs';
import { category, kind, minor } from './finance-schemas.mjs';

const correction = z
  .object({
    category: category.optional(),
    kind: kind.optional(),
    tags: tagsSchema.optional(),
    note: z.string().max(1000).optional(),
    splits: z
      .array(z.object({ category, amountMinor: minor }))
      .max(50)
      .optional()
  })
  .strict();

export function registerTransactionRoutes({ route, store, classification, ledger, filters }) {
  route('get', '/api/transactions', async (req) => ledger(req).transactionPage(filters(req)), { access: 'financial' });

  route('get', '/api/transactions/:id', (req) => ledger(req).getTransaction(req.params.id), { access: 'financial' });

  route(
    'patch',
    '/api/transactions/:id',
    async (req) => ledger(req).correctTransaction(req.params.id, correction.parse(await body(req))),
    { access: 'financial' }
  );

  route(
    'get',
    '/api/transactions/:id/audit',
    async (req) => ({
      audit: await ledger(req).audit(req.params.id)
    }),
    { access: 'financial' }
  );

  route('post', '/api/transactions/:id/suggest', async (req) => {
    const transaction = await (await createAccessStore(store, req.user)).assertTransaction(req.params.id, 'edit');
    if (transaction.manualEntryId) {
      throw Object.assign(Error('Manual entries use explicit categories'), { status: 400 });
    }

    return classification.suggest(req.params.id);
  });
}
