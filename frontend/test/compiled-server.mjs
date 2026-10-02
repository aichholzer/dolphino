import { createServer } from 'node:http';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { build } from 'vite';
import assert from 'node:assert/strict';

// Browser tests serve the actual production bundle. Inline test-only harnesses
// are compiled with the same Vite configuration; source serving is forbidden.
export async function createCompiledServer(options) {
  const root = options.root;
  const temporary = await mkdtemp(resolve(tmpdir(), 'dolphino-compiled-'));
  const inputs = [];
  const harnesses = new Map();
  const routes = new Map();
  const assetRoots = [resolve(root, 'dist')];
  const servedAssets = new Set();
  const developmentRequests = [];
  const vite = {
    middlewares: { use: (path, handler) => routes.set(path, handler) },
    async transformIndexHtml(path, html) {
      if (harnesses.has(path)) {
        return harnesses.get(path);
      }

      const stem = `browser-harness-${randomUUID()}`;
      const input = resolve(root, `${stem}.html`);
      const output = resolve(temporary, stem);
      inputs.push(input);
      await writeFile(input, html);
      await build({
        root,
        configFile: options.configFile,
        logLevel: 'error',
        build: { outDir: output, emptyOutDir: true, rollupOptions: { input } }
      });
      assetRoots.push(output);
      console.log(`Compiled special test harness: ${stem}`);
      const compiled = await readFile(resolve(output, `${stem}.html`), 'utf8');
      harnesses.set(path, compiled);
      return compiled;
    }
  };
  for (const plugin of options.plugins || []) {
    plugin.configureServer?.(vite);
  }

  const server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url, 'http://localhost').pathname;
      if (/^\/(src\/|@vite\/|@id\/|node_modules\/)/.test(path)) {
        developmentRequests.push(path);
        response.writeHead(500);
        response.end('Development source request forbidden in compiled verification');
        return;
      }

      if (routes.has(path)) {
        await routes.get(path)(request, response);
        return;
      }

      if (path.startsWith('/assets/')) {
        servedAssets.add(path);
      }

      const relative = extname(path) ? path.slice(1) : 'index.html';
      for (const dir of assetRoots) {
        try {
          const file = resolve(dir, relative);
          if (!file.startsWith(dir + '/')) {
            continue;
          }

          const data = await readFile(file);
          response.setHeader(
            'Content-Type',
            {
              '.js': 'application/javascript',
              '.css': 'text/css',
              '.html': 'text/html',
              '.svg': 'image/svg+xml',
              '.png': 'image/png'
            }[extname(file)] || 'application/octet-stream'
          );
          response.end(data);
          return;
        } catch {
          /* Try the next compiled asset directory. */
        }
      }

      response.writeHead(404);
      response.end('Not found');
    } catch (error) {
      console.error(error);
      response.writeHead(500);
      response.end(error.message);
    }
  });
  return {
    httpServer: server,
    async listen() {
      await new Promise((done) => server.listen(0, '127.0.0.1', done));
    },
    async close() {
      await new Promise((done) => server.close(done));
      await Promise.all(inputs.map((input) => rm(input, { force: true })));
      await rm(temporary, { recursive: true, force: true });
      assert.deepEqual(developmentRequests, []);
      assert.ok(servedAssets.size > 0, 'Compiled asset requests must be observed');
      console.log(`Verified production bundle serving: ${servedAssets.size} assets; zero development source requests`);
    }
  };
}
