import { z } from 'zod';
import { body } from '../http/body.mjs';

export function registerAccountRoutes({ route, ledger }) {
  route(
    'get',
    '/api/accounts',
    async (req) => ({
      accounts: await ledger(req).listAccounts()
    }),
    { access: 'financial' }
  );

  route(
    'patch',
    '/api/accounts/:id',
    async (req) =>
      ledger(req).updateAccountSettings(
        req.params.id,
        z
          .object({
            label: z.string().trim().max(100).optional(),
            description: z.string().trim().max(500).optional()
          })
          .strict()
          .parse(await body(req))
      ),
    { access: 'financial' }
  );
}
