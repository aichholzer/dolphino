import { createHash } from 'node:crypto';
import { z } from 'zod';
import { createAccessStore } from '../lib/access.mjs';
import { FINANCE_TOOLS, invokeFinanceTool } from '../lib/assistant-tools.mjs';
import { body } from '../http/body.mjs';

export function registerAssistantRoutes({ route, store, auth, assistant, assistantSettings, config }) {
  const assistantContext = (req) => async () => {
    const user = await auth.session(req);
    if (!user) {
      throw Object.assign(Error('Sign in required'), { status: 401 });
    }

    const finance = await createAccessStore(store, user);
    const permissions = await finance.permissions();
    if (!permissions.financialAccess) {
      throw Object.assign(Error('Financial access has not been granted'), {
        status: 403
      });
    }

    const fingerprint = createHash('sha256')
      .update(JSON.stringify({ id: user.id, role: user.role, permissions }))
      .digest('hex');
    // The assistant receives only read services, never Store/pool/credentials or mutation methods.
    const readOnly = Object.freeze(
      Object.fromEntries(
        [
          'permissions',
          'listAccounts',
          'listTransactions',
          'transactionPage',
          'getTransaction',
          'report',
          'listBudgets',
          'listCategories',
          'listReviews',
          'audit',
          'exportSnapshot'
        ].map((name) => [name, (...args) => finance[name](...args)])
      )
    );
    return { user, fingerprint, finance: readOnly };
  };

  route('get', '/api/assistant/status', () => assistantSettings.getUserStatus(), { access: 'member' });

  route(
    'get',
    '/api/assistant/tools',
    async (req) => {
      await assistantContext(req)();
      return { tools: FINANCE_TOOLS, readOnly: true };
    },
    { access: 'member' }
  );

  route(
    'post',
    '/api/assistant/tools/:name',
    async (req) =>
      invokeFinanceTool(req.params.name, await body(req), {
        getFinance: async () => (await assistantContext(req)()).finance,
        timeZone: config.timezone
      }),
    { access: 'member' }
  );

  route('get', '/api/assistant/chats', (req) => assistant.list({ getContext: assistantContext(req) }), {
    access: 'member'
  });

  route(
    'post',
    '/api/assistant/chats',
    async (req) => {
      z.object({})
        .strict()
        .parse(await body(req));
      return assistant.create({ getContext: assistantContext(req) });
    },
    { access: 'member' }
  );

  route(
    'get',
    '/api/assistant/chats/:id',
    (req) =>
      assistant.get({
        chatId: req.params.id,
        getContext: assistantContext(req)
      }),
    { access: 'member' }
  );

  route(
    'post',
    '/api/assistant/chats/:id/messages',
    async (req, res) => {
      const input = z
        .object({
          message: z.string().min(1).max(4000),
          acknowledgeDataSharing: z.literal(true)
        })
        .strict()
        .parse(await body(req));
      const cancel = new AbortController();
      const disconnected = () => {
        if (!res.writableEnded) {
          cancel.abort();
        }
      };

      req.once('aborted', disconnected);
      res.once('close', disconnected);
      try {
        return await assistant.send({
          ...input,
          chatId: req.params.id,
          getContext: assistantContext(req),
          signal: cancel.signal
        });
      } finally {
        req.off('aborted', disconnected);
        res.off('close', disconnected);
      }
    },
    { access: 'member' }
  );

  route(
    'post',
    '/api/assistant/chats/:id/cancel',
    (req) =>
      assistant.cancel({
        chatId: req.params.id,
        getContext: assistantContext(req)
      }),
    { access: 'member' }
  );

  route(
    'get',
    '/api/assistant/reports/:id',
    async (req, res) => {
      const report = await assistant.report({
        reportId: req.params.id,
        getContext: assistantContext(req)
      });
      res.setHeader('Content-Disposition', 'attachment; filename="dolphino-assistant-report.json"');
      return report;
    },
    { access: 'member' }
  );
}
