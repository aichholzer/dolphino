import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium as playwright } from '@playwright/test';

// Browser checks launch Chromium through this module. Under c8 (NODE_V8_COVERAGE set), every page
// records JS coverage for the compiled bundles and writes it to that directory in the same format
// Node uses. Each bundle is saved under browser-assets/ with its inline source map, which maps it
// back to frontend/src. Only a coverage build (vite build --mode coverage) carries those maps.
const target = process.env.NODE_V8_COVERAGE && resolve(process.env.NODE_V8_COVERAGE);
const assets = target && join(target, 'browser-assets');
let written = 0;

async function save(entries) {
  const result = [];
  for (const entry of entries) {
    if (!/\/assets\/[^/?#]+\.js(?:$|[?#])/.test(entry.url) || !entry.source) {
      continue;
    }

    const file = join(assets, `${createHash('sha256').update(entry.source).digest('hex').slice(0, 32)}.js`);
    await writeFile(file, entry.source, { flag: 'wx' }).catch((error) => {
      if (error.code !== 'EEXIST') {
        throw error;
      }
    });
    result.push({ scriptId: entry.scriptId, url: pathToFileURL(file).href, functions: entry.functions });
  }

  if (result.length) {
    await writeFile(join(target, `coverage-browser-${process.pid}-${written++}.json`), JSON.stringify({ result }));
  }
}

function instrument(browser) {
  const pages = new Set();
  async function collect(page) {
    if (!pages.delete(page)) {
      return;
    }

    try {
      await save(await page.coverage.stopJSCoverage());
    } catch (error) {
      if (!page.isClosed()) {
        throw error;
      }
    }
  }

  // Playwright's browser.newPage() goes through browser.newContext(). A page can arrive twice.
  async function track(page) {
    if (pages.has(page)) {
      return page;
    }

    guard(page.context());
    await page.coverage.startJSCoverage({ resetOnNavigation: false });
    pages.add(page);
    const close = page.close.bind(page);
    page.close = async (options) => {
      await collect(page);
      return close(options);
    };

    return page;
  }

  const collectContext = (context) => Promise.all([...pages].filter((page) => page.context() === context).map(collect));
  const guarded = new WeakSet();
  function guard(context) {
    if (guarded.has(context)) {
      return;
    }

    guarded.add(context);
    const close = context.close.bind(context);
    context.close = async (options) => {
      await collectContext(context);
      return close(options);
    };
  }

  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (options) => {
    const context = await newContext(options);
    const newPage = context.newPage.bind(context);
    context.newPage = async () => track(await newPage());
    guard(context);
    return context;
  };

  const newPage = browser.newPage.bind(browser);
  browser.newPage = async (options) => track(await newPage(options));
  const close = browser.close.bind(browser);
  browser.close = async (options) => {
    await Promise.all([...pages].map(collect));
    return close(options);
  };

  return browser;
}

export const chromium = {
  async launch(options) {
    const browser = await playwright.launch(options);
    if (!target) {
      return browser;
    }

    await mkdir(target, { recursive: true });
    await mkdir(assets, { recursive: true });
    return instrument(browser);
  }
};
