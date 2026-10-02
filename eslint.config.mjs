import js from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import globals from 'globals';

const javascriptFiles = ['**/*.{js,jsx,mjs,cjs}'];

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/test-results/**',
      '**/playwright-report/**',
      'artifacts/**',
      'secrets/**'
    ]
  },
  {
    ...js.configs.recommended,
    files: javascriptFiles,
    languageOptions: {
      ecmaVersion: 'latest'
    },
    plugins: {
      '@stylistic': stylistic
    },
    rules: {
      ...js.configs.recommended.rules,
      curly: ['error', 'all'],
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', ignoreRestSiblings: true }],
      '@stylistic/padding-line-between-statements': [
        'error',
        { blankLine: 'always', prev: 'function', next: '*' },
        { blankLine: 'always', prev: 'export', next: '*' },
        { blankLine: 'always', prev: 'multiline-block-like', next: '*' }
      ]
    }
  },
  {
    files: [
      'backend/**/*.{js,mjs,cjs}',
      'scripts/**/*.{js,mjs,cjs}',
      '**/*.config.{js,mjs,cjs}',
      'frontend/test/**/*.{js,mjs,cjs}'
    ],
    languageOptions: {
      globals: globals.node
    }
  },
  {
    files: ['frontend/src/**/*.{js,jsx,mjs}'],
    languageOptions: {
      globals: globals.browser
    }
  },
  {
    // These Node-based browser checks also execute callbacks in the page.
    files: ['scripts/browser-*.mjs', 'frontend/test/**/*.browser.mjs', 'frontend/test/browser-storage-guard.mjs'],
    languageOptions: {
      globals: globals.browser
    }
  },
  {
    // ESLint 10 tracks JSX references natively, including component imports.
    files: ['**/*.jsx'],
    languageOptions: {
      parserOptions: {
        ecmaFeatures: { jsx: true }
      }
    }
  }
];
