import { body } from '../http/body.mjs';

export function registerPocketSmithRoutes({ route, pocketsmith, sensitive }) {
  route('get', '/api/settings/pocketsmith', () => pocketsmith.status());
  route('put', '/api/settings/pocketsmith', async (req) => {
    sensitive('pocketsmith-save');
    return pocketsmith.save(await body(req), req.user);
  });
  for (const [path, method] of [
    ['test', 'discover'],
    ['account', 'configureAccount'],
    ['backfill', 'backfill']
  ]) {
    route('post', `/api/settings/pocketsmith/${path}`, async (req) => {
      sensitive(`pocketsmith-${path}`);
      return pocketsmith[method](await body(req), req.user);
    });
  }
}
