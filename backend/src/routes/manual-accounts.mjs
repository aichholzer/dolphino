import { z } from 'zod';
import { body } from '../http/body.mjs';
import { createManualLedger } from '../lib/manual-ledger.mjs';
import { createAccountLifecycle } from '../lib/account-lifecycle.mjs';
export function registerManualAccountRoutes({ route, store }) {
  const manual = (req) => createManualLedger(store, req.user);
  const lifecycle = (req) => createAccountLifecycle(store, req.user);
  const id = (req) => z.string().uuid().parse(req.params.id);
  route('post', '/api/manual/accounts', async (req) => manual(req).createAccount(await body(req)));
  route('post', '/api/manual/entries', async (req) => manual(req).createEntry(await body(req)), {
    access: 'financial'
  });
  route('get', '/api/manual/entries/:id', (req) => manual(req).getEntry(id(req)), { access: 'financial' });
  route('patch', '/api/manual/entries/:id', async (req) => manual(req).editEntry(id(req), await body(req)), {
    access: 'financial'
  });
  route('post', '/api/manual/entries/:id/void', async (req) => manual(req).voidEntry(id(req), await body(req)), {
    access: 'financial'
  });
  route('post', '/api/accounts/:id/lifecycle', async (req) => lifecycle(req).change(req.params.id, await body(req)), {
    access: 'financial'
  });
  route('get', '/api/settings/deleted-accounts', (req) => lifecycle(req).listDeleted());
  route('post', '/api/settings/deleted-accounts/preview', async (req) => lifecycle(req).preview(await body(req)));
  route('post', '/api/settings/deleted-accounts/purge', async (req) => lifecycle(req).purge(await body(req)));
}
