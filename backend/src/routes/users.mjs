import { z } from 'zod';
import { body } from '../http/body.mjs';

const grants = z
  .object({
    accounts: z
      .array(
        z
          .object({
            accountId: z.string().min(1).max(200),
            access: z.enum(['view', 'edit'])
          })
          .strict()
      )
      .max(1000),
    budgets: z
      .array(
        z
          .object({
            budgetId: z.string().uuid(),
            access: z.enum(['view', 'edit'])
          })
          .strict()
      )
      .max(1000)
  })
  .strict();

export function registerUserRoutes({ route, users, sensitive }) {
  route('get', '/api/users/grant-options', (req) => users.grantOptions({ actorId: req.user.id }));

  route('get', '/api/users', (req) => users.list({ actorId: req.user.id }));

  route('post', '/api/users/invitations', async (req) => {
    sensitive('invite-user');
    return users.invite({
      ...z
        .object({
          email: z.string().max(254),
          role: z.enum(['admin', 'member']),
          grants: grants.optional()
        })
        .strict()
        .parse(await body(req)),
      actorId: req.user.id
    });
  });

  route('post', '/api/users/invitations/:id/resend', (req) => {
    sensitive('resend-invite');
    return users.resend({ actorId: req.user.id, invitationId: req.params.id });
  });

  route('post', '/api/users/invitations/:id/revoke', (req) => {
    sensitive('revoke-invite');
    return users.revoke({ actorId: req.user.id, invitationId: req.params.id });
  });

  route('patch', '/api/users/:id', async (req) => {
    sensitive('change-role');
    return users.updateUser({
      ...z
        .object({
          role: z.enum(['admin', 'member']).optional(),
          disabled: z.boolean().optional(),
          grants: grants.optional()
        })
        .strict()
        .parse(await body(req)),
      actorId: req.user.id,
      userId: req.params.id
    });
  });

  route('post', '/api/users/:id/reset-password', (req) => {
    sensitive('reset-password');
    return users.resetPassword({ actorId: req.user.id, userId: req.params.id });
  });
}
