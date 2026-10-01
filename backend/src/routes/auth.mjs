import { z } from 'zod';
import { createAccessStore } from '../access.js';
import { body } from '../http/body.mjs';

export function registerAuthRoutes({ route, store, auth, users, sensitive, config }) {
  route(
    'get',
    '/api/health',
    async () => {
      await store.pool.query('SELECT 1');
      return { ok: true };
    },
    { access: 'public' }
  );

  route(
    'get',
    '/api/session',
    async (req) => {
      const user = await auth.session(req);
      const setup = await auth.setupStatus();
      const permissions = user
        ? await (await createAccessStore(store, user)).permissions()
        : { financialAccess: false, manageSettings: false };
      return {
        authenticated: !!user,
        user,
        setupRequired: setup.setupRequired,
        permissions,
        demo: config.mode === 'demo',
        currency: config.currency,
        timeZone: config.timezone
      };
    },
    { access: 'public' }
  );

  route(
    'post',
    '/api/auth/bootstrap',
    async (req, res) => {
      const result = await auth.bootstrap(
        req,
        z
          .object({
            email: z.string().max(254),
            name: z.string().max(100),
            password: z.string().max(1024),
            bootstrapToken: z.string().max(1024)
          })
          .strict()
          .parse(await body(req))
      );
      res.setHeader('Set-Cookie', result.cookie);
      return { ok: true, user: result.user };
    },
    { access: 'public' }
  );

  route(
    'post',
    '/api/login',
    async (req, res) => {
      const result = await auth.login(
        req,
        z
          .object({
            email: z.string().max(254),
            password: z.string().max(1024)
          })
          .strict()
          .parse(await body(req))
      );
      res.setHeader('Set-Cookie', result.cookie);
      return { ok: true, user: result.user };
    },
    { access: 'public' }
  );

  route(
    'post',
    '/api/logout',
    async (req, res) => {
      const result = await auth.logout(req);
      res.setHeader('Set-Cookie', result.cookie);
      return { ok: true };
    },
    { access: 'member' }
  );

  route(
    'post',
    '/api/auth/change-password',
    async (req, res) => {
      sensitive('change-password');
      const result = await auth.changePassword(
        req,
        z
          .object({
            currentPassword: z.string().max(1024),
            newPassword: z.string().max(1024)
          })
          .strict()
          .parse(await body(req))
      );
      res.setHeader('Set-Cookie', result.cookie);
      return { ok: true };
    },
    { access: 'member' }
  );

  route(
    'post',
    '/api/auth/activate',
    async (req) => {
      await auth.rate(req, 'activation');
      return users.activate(
        z
          .object({
            token: z.string().max(1024),
            password: z.string().max(1024),
            name: z.string().max(100).optional()
          })
          .strict()
          .parse(await body(req))
      );
    },
    { access: 'public' }
  );
}
