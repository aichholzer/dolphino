import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Design-system regression checks; these complement, not replace, browser QA.
const css = await readFile("frontend/src/style.css", "utf8");
const main = await readFile("frontend/src/main.jsx", "utf8");
const tokens = Object.fromEntries(
  [...css.matchAll(/--([a-z-]+):\s*(#[a-f\d]{6});/g)].map((m) => [m[1], m[2]]),
);
const definitions = new Set(
  [...css.matchAll(/--([a-z-]+):/g)].map((m) => m[1]),
);
for (const [, token] of (css + main).matchAll(/var\(--([a-z-]+)\)/g))
  assert(definitions.has(token), `Undefined theme token: ${token}`);
function luminance(hex) {
  const rgb = hex.match(/[a-f\d]{2}/gi).map((v) => {
    const x = parseInt(v, 16) / 255;
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  });
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}
function contrast(a, b) {
  const values = [luminance(a), luminance(b)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}
const pairs = [
  ["Primary text", tokens.ink, tokens.canvas],
  ["Secondary text", tokens["ink-soft"], tokens.surface],
  ["Muted text", tokens.muted, tokens.canvas],
  ["Muted text on sea glass", tokens.muted, tokens["sea-glass"]],
  ["Ocean text on light blue", tokens.ocean, tokens["ocean-soft"]],
  ["Income / success", tokens["sea-green"], tokens["sea-glass"]],
  ["Spending", tokens.coral, tokens["coral-soft"]],
  ["Warning", tokens.sun, tokens["sun-soft"]],
  ["Error", tokens.danger, tokens["danger-soft"]],
  ["Primary button", tokens.surface, tokens["ocean-deep"]],
  ["Primary button hover", tokens.surface, tokens.ocean],
  ["Navigation", tokens.muted, tokens.surface],
  ["Sidebar secondary text", tokens.muted, tokens.surface],
  ["Workspace secondary text", tokens.muted, tokens.surface],
  ["Navigation hover", tokens.ocean, tokens["surface-soft"]],
];
for (const [name, foreground, background] of pairs) {
  const ratio = contrast(foreground, background);
  assert(ratio >= 4.5, `${name} contrast ${ratio.toFixed(2)}:1 is below AA`);
  console.log(`${name}: ${ratio.toFixed(2)}:1`);
}
for (const background of [
  "surface",
  "canvas",
  "sea-glass",
  "coral-soft",
  "ocean-soft",
])
  assert(
    contrast(tokens.focus, tokens[background]) >= 3,
    `Focus on ${background}`,
  );
assert(contrast(tokens.focus, tokens.surface) >= 3, "Sidebar focus");
assert(
  !/purple|violet|indigo/i.test(css + main),
  "Obsolete purple theme remains",
);
assert(main.includes('color="ocean"'), "Net cash flow ocean semantic class");
for (const name of ["ocean", "sky", "sea", "coral", "sun", "tide"])
  assert(main.includes(`var(--chart-${name})`), `Chart ${name} token not used`);
const asset = await readFile("frontend/public/dolphino.svg", "utf8");
assert.equal(asset, await readFile("artifacts/dolphino-logo.svg", "utf8"));
// Original dolphin outline and detail are intentionally unchanged.
assert(
  asset.includes(
    'd="M59 22c-4-4-8-5-13-4-3-5-7-9-11-10 1 6 0 10-3 13-9 2-15 8-19 16-4 0-7-2-10-4 0 6 3 10 7 11-3 3-5 8-4 13 5-3 10-5 12-11 6 0 12-1 17-4l-1 9c5-4 8-9 9-14 6-5 9-10 16-9 3 0 5-1 4-3z"',
  ),
);
assert(asset.includes('d="M19 40c9 2 19-1 26-8-4 8-14 13-25 13z"'));
assert(asset.includes('viewBox="0 0 64 64"'));
assert(!/https?:\/\//.test(css), "Theme must not fetch remote assets or fonts");
console.log(
  "Ocean theme tokens, AA text contrast, focus contrast and original SVG geometry passed.",
);
