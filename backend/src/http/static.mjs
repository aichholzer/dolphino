import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { send } from './response.mjs';

export function createStaticHandler(securityHeaders) {
  return async function staticFile(req, res) {
    securityHeaders(res);
    if (req.url.startsWith('/api/')) {
      return send(res, { error: 'Not found' }, 404);
    }

    if (req.method !== 'GET') {
      return send(res, { error: 'Not found' }, 404);
    }

    try {
      const root = resolve('frontend/dist');
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      if (pathname.split('/').some((segment) => segment.startsWith('.'))) {
        return send(res, { error: 'Not found' }, 404);
      }

      const path = resolve(root, '.' + pathname);
      if (!path.startsWith(root + '/') && path !== root) {
        return send(res, { error: 'Not found' }, 404);
      }

      let data;
      let ext = extname(path);
      try {
        data = await readFile(path);
      } catch {
        if (ext) {
          return send(res, { error: 'Not found' }, 404);
        }

        data = await readFile(resolve(root, 'index.html'));
        ext = '.html';
      }

      res.writeHead(200, {
        'Content-Type':
          {
            '.html': 'text/html',
            '.js': 'text/javascript',
            '.css': 'text/css',
            '.svg': 'image/svg+xml',
            '.png': 'image/png'
          }[ext] || 'application/octet-stream',
        'Content-Security-Policy':
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'self'"
      });
      res.end(data);
    } catch {
      send(res, { error: 'Frontend not built. Run npm run build.' }, 503);
    }
  };
}
