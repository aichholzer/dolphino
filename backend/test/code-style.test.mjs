import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import * as prettier from 'prettier';

const cwd = fileURLToPath(new URL('../..', import.meta.url));
const filePath = 'backend/src/lib/style-probe.mjs';
const paddingRule = '@stylistic/padding-line-between-statements';
const lint = new ESLint({ cwd });
const fixer = new ESLint({ cwd, fix: true });

test('code style keeps recommended safety checks and only the requested stylistic rule', async () => {
  const config = await lint.calculateConfigForFile(filePath);
  assert.deepEqual(config.rules[paddingRule], [
    2,
    { blankLine: 'always', prev: 'function', next: '*' },
    { blankLine: 'always', prev: 'export', next: '*' },
    { blankLine: 'always', prev: 'multiline-block-like', next: '*' }
  ]);
  assert.deepEqual(config.rules.curly, [2, 'all']);
  assert.equal(config.rules['no-undef'][0], 2);
  assert.equal(config.rules['no-unused-vars'][0], 2);
  assert.equal(config.rules['no-unused-vars'][1].argsIgnorePattern, '^_');
  assert.equal(config.rules['no-unused-vars'][1].ignoreRestSiblings, true);
  assert.deepEqual(
    Object.keys(config.rules).filter((rule) => rule.startsWith('@stylistic/')),
    [paddingRule]
  );
});

for (const [kind, source] of [
  ['function', 'function readMode() {\n  return process.env.MODE;\n}\nreadMode();\n'],
  ['export', 'export const first = 1;\nexport const second = 2;\n'],
  [
    'multiline block',
    "if (process.env.ENABLED) {\n  process.stdout.write('enabled');\n}\nprocess.stdout.write('ready');\n"
  ]
]) {
  test(`padding is required after ${kind} statements and survives Prettier`, async () => {
    const [invalid] = await lint.lintText(source, { filePath });
    assert.equal(invalid.messages.filter((message) => message.ruleId === paddingRule).length, 1);
    const [fixed] = await fixer.lintText(source, { filePath });
    assert.equal(fixed.errorCount, 0, JSON.stringify(fixed.messages));
    assert(fixed.output?.includes('\n\n'));
    const options = await prettier.resolveConfig(new URL('../../.prettierrc.json', import.meta.url));
    const formatted = await prettier.format(fixed.output, { ...options, parser: 'babel' });
    const [verified] = await lint.lintText(formatted, { filePath });
    assert.equal(verified.errorCount, 0, JSON.stringify(verified.messages));
    const [stable] = await fixer.lintText(formatted, { filePath });
    assert.equal(stable.output ?? formatted, formatted);
    assert.equal(await prettier.format(formatted, { ...options, parser: 'babel' }), formatted);
  });
}

test('Prettier retains the exact shared formatting contract', async () => {
  const options = await prettier.resolveConfig(new URL('../../.prettierrc.json', import.meta.url));
  assert.deepEqual(options, {
    printWidth: 120,
    tabWidth: 2,
    singleQuote: true,
    semi: true,
    useTabs: false,
    trailingComma: 'none',
    bracketSpacing: true,
    arrowParens: 'always'
  });
});
