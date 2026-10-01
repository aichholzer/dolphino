import { z } from 'zod';
import { body } from '../http/body.mjs';
import { category, minor } from './finance-schemas.mjs';

const budget = z
  .object({
    category,
    capMinor: minor,
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .default('AUD'),
    month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
    allocationMinor: minor.optional(),
    rolloverEnabled: z.boolean().optional(),
    rollover: z.boolean().optional()
  })
  .strict();

export function registerBudgetRoutes({ route, ledger, report }) {
  route(
    'get',
    '/api/budgets',
    async (req) => {
      const r = await report(req);
      return {
        budgets: r.budgets.map((b) => ({
          ...b,
          rolloverMinor: b.carryMinor,
          rolloverEnabled: b.rollover
        })),
        alerts: r.alerts
      };
    },
    { access: 'financial' }
  );

  route('put', '/api/budgets', async (req) => ledger(req).saveBudget(budget.parse(await body(req))), {
    access: 'financial'
  });

  route('delete', '/api/budgets/:id', (req) => ledger(req).deleteBudget(req.params.id), { access: 'financial' });
}
