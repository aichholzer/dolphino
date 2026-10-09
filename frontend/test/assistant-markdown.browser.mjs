import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import { chromium } from './browser.mjs';
import { createCompiledServer } from './compiled-server.mjs';
import { installBrowserStorageGuard } from './browser-storage-guard.mjs';

const normal = [
  '# Spending summary',
  'You spent **AUD 42.75** on *Eating out*. ~~Old estimate~~ &amp; &#169;.',
  '- First item\n- Second item\n  - Nested detail',
  '3. Third\n4. Fourth',
  '> Synthetic figures only.',
  '- [x] Reviewed\n- [ ] Follow up',
  'Inline `a < b && c` and escaped \\*literal\\*; path C:\\reports\\month.',
  '```html\n<img src="https://tracking.invalid/code" onerror="alert(1)">\n&amp; stays literal in code\n```',
  '| Category | Amount | Notes |\n| --- | ---: | --- |\n| Eating out | **AUD 42.75** | Synthetic |',
  'First line  \nSecond line',
  '---',
  '[Reference label](https://tracking.invalid/link) ![Image description](https://tracking.invalid/image)',
  'Encoded text: &lt;img src=x onerror=alert(1)&gt;'
].join('\n\n');
const attacks = [
  '<script>globalThis.markdownExecuted = true; alert(1)</script>',
  '<img src="/api/markdown-trap" onerror="alert(1)">',
  '<svg onload="alert(1)"><a xlink:href="javascript:alert(1)">svg</a></svg>',
  '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
  '<style>body { background: url(https://tracking.invalid/css) }</style>',
  '<form action="/api/markdown-trap"><input autofocus onfocus="alert(1)"><button>Submit</button></form>',
  '<object data="https://tracking.invalid/object"></object><embed src="https://tracking.invalid/embed">',
  '<meta http-equiv="refresh" content="0;url=https://tracking.invalid"><base href="https://tracking.invalid">',
  '[Click](javascript:alert%281%29)',
  '[Click](java&#x73;cript:alert%281%29)',
  '[Click](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
  '[Click](vbscript:msgbox%281%29) [Blob](blob:https://tracking.invalid/id)',
  '[Click](//tracking.invalid/pixel) [Local](/api/markdown-trap)',
  '[Mail](mailto:test@tracking.invalid) <https://tracking.invalid/autolink> <test@tracking.invalid>',
  '[Click][ref]\n\n[ref]: https://tracking.invalid/ref',
  '![alt](https://tracking.invalid/pixel) ![local](/api/markdown-trap) ![data](data:image/svg+xml;base64,PHN2Zy8+)',
  '[![nested](https://tracking.invalid/nested)](javascript:alert%281%29)',
  '[Label](https://tracking.invalid "onclick=alert(1)")',
  '![alt][ref]\n\n[ref]: https://tracking.invalid/reference-image',
  '<math><mtext><img src=x onerror=alert(1)></mtext></math>',
  '```html\n<script>alert(1)</script>\n```',
  '```js" onmouseover="alert(1)\nconst safe = true;\n```'
];
const server = await createCompiledServer({ root: fileURLToPath(new URL('..', import.meta.url)) });
await server.listen();
const base = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
  args: ['--no-sandbox']
});
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
const page = await context.newPage();
const errors = [],
  unexpected = [],
  dialogs = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('dialog', async (dialog) => {
  dialogs.push(dialog.message());
  await dialog.dismiss();
});
const noStorage = await installBrowserStorageGuard(page);
let answer = normal,
  chat = { id: 'markdown_chat', messages: [], status: 'idle' };
await context.route('**/*', async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  if (url.origin !== base || /markdown-trap|^\/(src|@vite|@id|node_modules)\//.test(url.pathname)) {
    unexpected.push(url.href);
    await route.abort();
    return;
  }

  if (!url.pathname.startsWith('/api/')) {
    await route.continue();
    return;
  }

  let data = {};
  if (url.pathname === '/api/session') {
    data = {
      authenticated: true,
      user: { id: 'markdown_user', role: 'member' },
      permissions: { accounts: [{ accountId: 'synthetic', access: 'view' }] }
    };
  } else if (url.pathname === '/api/assistant/status') {
    data = { enabled: true, configured: true, disclosure: 'Synthetic sharing consent.' };
  } else if (url.pathname === '/api/assistant/chats' && request.method() === 'GET') {
    data = { chats: [] };
  } else if (url.pathname === '/api/assistant/chats') {
    data = chat;
  } else if (url.pathname.endsWith('/messages')) {
    chat = {
      ...chat,
      messages: [
        { role: 'user', content: request.postDataJSON().message },
        { role: 'assistant', content: answer }
      ]
    };
    data = { chat, reply: answer };
  }

  await route.fulfill({ json: data });
});
try {
  await page.goto(base);
  await page.getByRole('button', { name: 'Ask Dolphino', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const question = dialog.getByLabel('Ask a financial question', { exact: true });
  const rendered = dialog.locator('.assistant-markdown');
  async function send(content) {
    answer = content;
    await question.fill('**User remains plain**\n- literal bullet\n<img src=x onerror=alert(1)>');
    const response = page.waitForResponse((r) => r.url().endsWith('/messages'));
    await question.press('Enter');
    assert.equal((await (await response).json()).reply, content);
    await expect(dialog.getByRole('button', { name: 'Send', exact: true })).toBeVisible();
    await expect(rendered).toHaveCount(1);
  }

  await send(normal);
  await expect(rendered.getByRole('heading', { name: 'Spending summary', level: 3 })).toBeVisible();
  await expect(rendered.locator('p > strong').first()).toHaveText('AUD 42.75');
  await expect(rendered.locator('em')).toHaveText('Eating out');
  await expect(rendered.locator('del')).toHaveText('Old estimate');
  await expect(rendered.locator('ul ul li')).toHaveText('Nested detail');
  await expect(rendered.locator('ol')).toHaveAttribute('start', '3');
  await expect(rendered.locator('blockquote')).toHaveText('Synthetic figures only.');
  await expect(rendered).toContainText('[Done] Reviewed');
  await expect(rendered).toContainText('[To do] Follow up');
  await expect(rendered).toContainText('& ©');
  await expect(rendered).toContainText('escaped *literal*; path C:\\reports\\month.');
  await expect(rendered).toContainText('Reference label Image description');
  await expect(rendered).toContainText('Encoded text: <img src=x onerror=alert(1)>');
  await expect(rendered.locator('pre code')).toContainText('&amp; stays literal in code');
  await expect(rendered.locator('th[scope="col"]')).toHaveCount(3);
  await expect(rendered.locator('td strong')).toHaveText('AUD 42.75');
  await expect(rendered.locator('br')).toHaveCount(1);
  await expect(rendered.locator('hr')).toHaveCount(1);
  const user = dialog.locator('.assistant-message-user');
  await expect(user.locator('p')).toHaveText('**User remains plain**\n- literal bullet\n<img src=x onerror=alert(1)>');
  await expect(user.locator('p strong, p li, img')).toHaveCount(0);
  // Native selection/copy uses readable text without mutating the stored reply.
  const selected = await rendered.evaluate((element) => {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
    const text = selection.toString();
    selection.removeAllRanges();
    return text;
  });
  assert.ok(selected.includes('AUD 42.75') && !selected.includes('**AUD 42.75**'));
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect(rendered.getByRole('region', { name: 'Code block' })).toHaveAttribute('tabindex', '0');
    await rendered.getByRole('region', { name: 'Response table' }).focus();
    await expect(rendered.getByRole('region', { name: 'Response table' })).toBeFocused();
    if (width === 320) {
      for (const name of ['Code block', 'Response table']) {
        const region = rendered.getByRole('region', { name });
        await region.focus();
        await page.keyboard.press('ArrowRight');
        await expect.poll(() => region.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
      }
    }

    assert.equal(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth), true);
    assert.equal(await page.locator('body').evaluate((el) => el.scrollWidth <= innerWidth), true);
    await dialog.locator('.assistant-transcript').evaluate((el) => (el.scrollTop = 0));
    await page.screenshot({ path: `/tmp/dolphino-assistant-markdown-${width}.png` });
  }

  const prohibited =
    'a, img, svg, script, style, iframe, object, embed, form, input, button, video, audio, math, link, meta, base, [href], [src], [srcdoc], [style], [onclick], [onerror], [onload], [autofocus], [id]';
  for (const attack of attacks) {
    await send(`Before\n\n${attack}\n\nAfter`);
    await expect(rendered).toContainText('After');
    await expect(rendered.locator(prohibited)).toHaveCount(0);
    assert.equal(page.url(), `${base}/`);
  }

  await send(`**Long content**\n\n${'word'.repeat(2500)}\n\n${'Paragraph with *emphasis*.\n\n'.repeat(100)}`);
  assert.equal(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth), true);
  for (const content of ['> '.repeat(50) + '**Deep**', '*a* '.repeat(6000), 'x'.repeat(66000)]) {
    await send(content);
    await expect(rendered.locator('.assistant-markdown-plain')).toHaveText(content);
  }

  await send('\\*\\*Literal bold markers\\*\\* and **real bold**.');
  await expect(rendered).toHaveText('**Literal bold markers** and real bold.');
  await expect(rendered.locator('strong')).toHaveText('real bold');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: 'Ask Dolphino', exact: true })).toBeFocused();
  await noStorage();
  assert.deepEqual(unexpected, []);
  assert.deepEqual(errors, []);
  assert.deepEqual(dialogs, []);
  assert.equal(context.pages().length, 1);
  console.log(
    `Compiled Markdown passed: semantic formatting, entity/escape/code fidelity, plaintext user, selection, accessible scroll regions at 1440/390/320px, ${attacks.length} hostile payloads, no executable DOM/navigation/remote or relative fetches, long/deep fallback, no storage. All values synthetic.`
  );
} finally {
  await context.close();
  await browser.close();
  await server.close();
}
