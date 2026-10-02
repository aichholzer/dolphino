import { z } from 'zod';
import { body } from '../http/body.mjs';

export function registerIntegrationRoutes({ route, integration, registration, simplefin, importHealth, sensitive }) {
  route('get', '/api/settings/simplefin', () => simplefin.status());

  for (const [path, method] of [
    ['connect', 'connect'],
    ['disconnect', 'disconnect'],
    ['test', 'discover'],
    ['map', 'mapAccount'],
    ['backfill', 'backfill']
  ]) {
    route('post', `/api/settings/simplefin/${path}`, async (req) => {
      sensitive(`simplefin-${path}`);
      const input = await body(req);
      if (path === 'test') {
        z.object({}).strict().parse(input);
      }

      return simplefin[method](input);
    });
  }

  route('put', '/api/settings/simplefin', async (req) => {
    sensitive('simplefin-save');
    return simplefin.save(await body(req));
  });

  route('get', '/api/settings/webhook', () => registration.status());

  route('post', '/api/settings/webhook/register', async (req) => {
    sensitive('webhook-register');
    if (!(await integration.status()).verified) {
      throw Object.assign(Error('Test the Redbark connection successfully before registering'), { status: 409 });
    }

    return registration.register(
      z
        .object({
          publicBaseUrl: z.string().max(2048),
          recoverSigningSecret: z.boolean().default(false)
        })
        .strict()
        .parse(await body(req))
    );
  });

  route('post', '/api/settings/webhook/test', () => {
    sensitive('webhook-test');
    return registration.test();
  });

  route('get', '/api/import-health', () => importHealth.status());

  route('post', '/api/import-health/repair-categories', async (req) => {
    sensitive('category-repair');
    z.object({})
      .strict()
      .parse(await body(req));
    return importHealth.repairCategories();
  });

  route('post', '/api/import-health/backfill', async (req) => {
    sensitive('backfill');
    return importHealth.backfill(
      z
        .object({
          accountId: z.string().min(1).max(200),
          from: z.string().max(10),
          to: z.string().max(10)
        })
        .strict()
        .parse(await body(req))
    );
  });

  route('post', '/api/import-health/retry', async (req) => {
    sensitive('import-retry');
    return importHealth.retry(
      z
        .object({
          jobId: z.union([z.string().regex(/^\d+$/), z.number().int().positive()])
        })
        .strict()
        .parse(await body(req))
    );
  });

  route('post', '/api/connection/test', () => {
    sensitive('redbark-test');
    return integration.testConnection();
  });

  route(
    'post',
    '/api/webhooks/redbark',
    async (req) => integration.receiveWebhook(await body(req, true), req.headers),
    { access: 'public', webhook: true }
  );
}
