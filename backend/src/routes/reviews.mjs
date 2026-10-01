import { z } from 'zod';
import { body } from '../http/body.mjs';

export function registerReviewRoutes({ route, ledger }) {
  route(
    'get',
    '/api/reviews',
    async (req) => ({
      reviews: await ledger(req).listReviews()
    }),
    { access: 'financial' }
  );

  route(
    'post',
    '/api/reviews/:id',
    async (req) => {
      const value = z
        .object({
          action: z.enum(['dismiss', 'keep', 'link']),
          transactionId: z.string().optional(),
          pendingId: z.string().optional()
        })
        .strict()
        .parse(await body(req));
      return ledger(req).resolveReview(req.params.id, {
        action: value.action === 'dismiss' ? 'keep' : value.action,
        pendingId: value.pendingId || value.transactionId
      });
    },
    { access: 'financial' }
  );
}
