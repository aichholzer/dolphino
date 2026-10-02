import { z } from 'zod';
import { createAccessStore } from '../lib/access.mjs';
import { send } from './response.mjs';
import { createClientIpResolver } from './client-ip.mjs';

// All domain routes share this boundary; new routes require administrator access by default.
export function createRouteRegistrar({ app, store, auth, config, securityHeaders }) {
  const resolveClientIp = createClientIpResolver(config?.trustProxy);
  return function route(method, path, handler, { access = 'admin', webhook = false } = {}) {
    if (!['admin', 'public', 'member', 'financial'].includes(access)) {
      throw new TypeError(`Unknown route access policy: ${access}`);
    }

    app[method](path, (req, res) => {
      Promise.resolve()
        .then(async () => {
          securityHeaders(res);
          req.clientIp = resolveClientIp(req);
          if (access !== 'public') {
            req.user = await auth.session(req);
            if (!req.user) {
              return send(res, { error: 'Sign in required' }, 401);
            }

            if (access === 'admin' && req.user.role !== 'admin') {
              return send(res, { error: 'Administrator access required' }, 403);
            }

            if (access === 'financial') {
              req.accessStore = await createAccessStore(store, req.user);
            }
          }

          if (!webhook && !['GET', 'HEAD'].includes(req.method) && req.headers.origin !== config.origin) {
            return send(res, { error: 'Origin not allowed' }, 403);
          }

          req.query = Object.fromEntries(new URL(req.url, 'http://localhost').searchParams);
          const result = await handler(req, res);
          if (!res.writableEnded && !res.destroyed) {
            send(res, result ?? { ok: true });
          }
        })
        .catch((e) => {
          if (res.writableEnded || res.destroyed) {
            return;
          }

          const status =
            e instanceof z.ZodError ? 400 : e.status || (['23505', '23514', '22P02'].includes(e.code) ? 400 : 500);
          send(
            res,
            {
              error:
                status < 500 || e.expose === true
                  ? e instanceof z.ZodError
                    ? 'Invalid request fields'
                    : e.message
                  : 'Operation failed. Check configuration and database availability.'
            },
            status
          );
        });
    });
  };
}
