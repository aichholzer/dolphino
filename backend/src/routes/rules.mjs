import { z } from 'zod';
import { body } from '../http/body.mjs';
import { category, kind } from './finance-schemas.mjs';
import { tagsSchema } from '../lib/category-catalog.mjs';

const rule = z
  .object({
    id: z.string().uuid().optional(),
    match: z.string().trim().min(1).max(200),
    category,
    kind: kind.optional(),
    priority: z.number().int().min(0).max(1000).optional(),
    tags: tagsSchema.optional()
  })
  .strict();

export function registerRuleRoutes({ route, store }) {
  route('get', '/api/rules', async () => ({ rules: await store.listRules() }));
  route('post', '/api/rules/preview', async (req) => store.previewRule(rule.parse(await body(req))));
  route('post', '/api/rules', async (req) => store.saveRule(rule.parse(await body(req))));
  route('delete', '/api/rules/:id', (req) => store.deleteRule(req.params.id));
}
