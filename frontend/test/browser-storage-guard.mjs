import assert from 'node:assert/strict';

const installed = new WeakMap();

/** Fail on browser-side app storage, even when application code catches the error. */
export async function installBrowserStorageGuard(page) {
  if (installed.has(page)) {
    return installed.get(page);
  }

  const violations = [];
  await page.exposeBinding('__dolphinoReportStorageAccess', (_source, operation) => {
    violations.push(operation);
  });
  await page.addInitScript(() => {
    const deny = (operation) => {
      // Report outside the document so navigation cannot erase the evidence.
      void globalThis.__dolphinoReportStorageAccess(operation);
      throw new Error(`Browser application storage is forbidden: ${operation}`);
    };

    for (const name of ['localStorage', 'sessionStorage', 'indexedDB', 'caches']) {
      Object.defineProperty(globalThis, name, {
        configurable: false,
        get: () => deny(`read window.${name}`),
        set: () => {
          deny(`write window.${name}`);
        }
      });
    }

    if (navigator.serviceWorker) {
      Object.defineProperty(navigator.serviceWorker, 'register', {
        configurable: false,
        value: () => deny('navigator.serviceWorker.register')
      });
    }
  });
  const assertNoStorageAccess = async () => {
    // Flush pending bindings from the current document before asserting.
    await page.evaluate(() => globalThis.__dolphinoReportStorageAccess(null));
    const accesses = violations.filter((operation) => operation !== null);
    assert.deepEqual(accesses, [], 'The application must not access browser app-data storage');
  };

  installed.set(page, assertNoStorageAccess);
  return assertNoStorageAccess;
}
