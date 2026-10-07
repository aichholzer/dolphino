import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';
import { JSDOM } from 'jsdom';

// Hooks run in Node against a jsdom window. Source modules import JSX files without
// an extension, as Vite allows, so this resolves and compiles them the same way.
// Import this module first, then load React DOM and the code under test dynamically.
const source = new URL('../src/', import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    if (!context.parentURL?.startsWith(source) || !specifier.startsWith('.') || /\.[cm]?jsx?$/.test(specifier)) {
      return next(specifier, context);
    }

    for (const extension of ['.jsx', '.mjs', '.js']) {
      try {
        return next(specifier + extension, context);
      } catch {
        // Try the next extension.
      }
    }

    return next(specifier, context);
  },
  load(url, context, next) {
    if (!url.startsWith(source) || !url.endsWith('.jsx')) {
      return next(url, context);
    }

    const file = fileURLToPath(url);
    const { code } = transformSync(readFileSync(file, 'utf8'), {
      loader: 'jsx',
      jsx: 'automatic',
      format: 'esm',
      sourcemap: 'inline',
      sourcefile: file
    });
    return { format: 'module', source: code, shortCircuit: true };
  }
});

export const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://dolphino.test/' });

for (const key of ['window', 'document', 'location', 'history', 'navigator']) {
  Object.defineProperty(globalThis, key, {
    value: key === 'window' ? dom.window : dom.window[key],
    configurable: true
  });
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
// React reports act() misuse and update loops through console.error, and jsdom reports
// unimplemented APIs the same way. Any of them fails the test file.
const consoleError = console.error;
let reported = 0;
console.error = (...args) => {
  reported++;
  consoleError(...args);
};

process.on('exit', () => {
  if (reported) {
    process.exitCode = 1;
  }
});
const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
export { act, createElement };

export function renderHook(hook, { props, wrapper } = {}) {
  const result = { current: undefined, renders: 0 };
  function Probe({ value }) {
    result.current = hook(value);
    result.renders++;
    return null;
  }

  const root = createRoot(document.createElement('div'));
  const render = (value) => {
    const probe = createElement(Probe, { value });
    root.render(wrapper ? createElement(wrapper, null, probe) : probe);
  };

  act(() => render(props));
  return {
    result,
    rerender: (value) => act(() => render(value)),
    unmount: () => act(() => root.unmount())
  };
}

// Let pending promises and React updates settle.
export async function settle(ms = 5) {
  await act(() => new Promise((resolve) => setTimeout(resolve, ms)));
}

// Responses for the app's own fetch-based api() helper, keyed by path.
export function stubFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    const path = url.replace(/^\/api/, '');
    const handler = routes[path] ?? routes[path.split('?')[0]];
    if (!handler) {
      return Response.json({ error: `Unexpected request ${url}` }, { status: 500 });
    }

    const reply = typeof handler === 'function' ? await handler({ url, options, calls }) : handler;
    return reply instanceof Response ? reply : Response.json(reply);
  };

  return calls;
}

export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
