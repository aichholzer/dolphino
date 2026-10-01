import { z } from 'zod';
import { body } from '../http/body.mjs';
import { category, kind } from './finance-schemas.mjs';

export function registerRuleRoutes({ route, store }) {
  route('get', '/api/rules', async () => ({ rules: await store.listRules() }));

  route('post', '/api/rules', async (req) =>
    store.saveRule(
      z
        .object({
          match: z.string().min(1).max(200),
          category,
          kind: kind.optional(),
          priority: z.number().int().min(0).max(1000).optional()
        })
        .strict()
        .parse(await body(req))
    )
  );

  route('delete', '/api/rules/:id', (req) => store.deleteRule(req.params.id));
}
