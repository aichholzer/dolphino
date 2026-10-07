import { chromium } from './browser.mjs';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
  args: ['--no-sandbox']
});
try {
  const page = await browser.newPage({
    viewport: { width: 960, height: 680 },
    deviceScaleFactor: 1
  });
  const svg = await readFile('frontend/public/dolphino.svg', 'utf8'),
    mono = await readFile('frontend/public/dolphino-mono.svg', 'utf8');
  const image = (s) => `data:image/svg+xml;base64,${Buffer.from(s).toString('base64')}`;
  await page.setContent(
    `<html><head><style>body{margin:0;background:#f6f7f2;color:#173847;font-family:Arial,sans-serif;padding:48px}h1{font-size:38px;letter-spacing:-1.5px;margin:0}p{font-size:13px;color:#58717a}.hero{display:flex;align-items:center;gap:20px;margin:28px 0 48px}.hero img{width:128px;height:128px}.row{display:flex;align-items:end;gap:44px;padding:30px;background:white;border-radius:18px}.size{text-align:center;font-size:12px;color:#58717a}.size img{display:block;margin:auto auto 18px}.mono{margin-top:28px;display:flex;gap:20px;align-items:center}.mono img{width:48px;height:48px}</style></head><body><h1>dolphino</h1><p>Original editable vector identity · ocean blue and monochrome</p><div class="hero"><img src="${image(svg)}" alt="dolphino dolphin"/><div><h1>dolphino<span style="color:#14627b">.</span></h1><p>A little more clarity.</p></div></div><div class="row">${[16, 24, 48, 96, 160].map((n) => `<div class="size"><img src="${image(svg)}" width="${n}" height="${n}" alt="Dolphin mark ${n} pixels"/>${n}px</div>`).join('')}</div><div class="mono"><img src="${image(mono)}" alt="Monochrome dolphin"/><p>One color · no raster layers, fonts or external dependencies</p></div></body></html>`
  );
  await page.locator('img').evaluateAll(async (imgs) => Promise.all(imgs.map((i) => i.decode())));
  assert(await page.locator('img').evaluateAll((imgs) => imgs.every((i) => i.complete && i.naturalWidth > 0)));
  await page.screenshot({
    path: 'artifacts/dolphino-logo-preview.png',
    fullPage: true
  });
  console.log('dolphino SVG logo rendered successfully at 16, 24, 48, 96 and 160 pixels, plus monochrome.');
} finally {
  await browser.close();
}
