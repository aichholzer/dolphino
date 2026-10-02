import { accountBalances } from '../../../shared/account-balances.mjs';
import { z } from 'zod';
import { body } from '../http/body.mjs';

export function registerAccountRoutes({ route, ledger }) {
  route(
    'get',
    '/api/accounts',
    async (req) => {
      const accounts = await ledger(req).listAccounts();
      return { accounts, accountBalances: accountBalances(accounts) };
    },
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
