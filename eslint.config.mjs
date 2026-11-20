/**
 * ESLint, a dev-only tool of the repo root, run by `npm run lint` and `npm run
 * check`, over backend/, frontend/src/ and shared/. Correctness rules only
 * (docs/TECH-STACK.md, Testing & lint): no style rule. `react-hooks/exhaustive-deps`
 * stays off until the hooks that own the dependency arrays exist.
 *
 * Inline config (`eslint-disable`, `/* global *\/`, `/* eslint … *\/`) is not
 * honoured, and `npm run lint` fails on the warning it leaves: an allowance, if
 * one is ever needed, is a reviewed line here, like the lists of the other checks.
 */
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';

const correctness = {
  'no-undef': 'error',
  'no-unused-vars': ['error', { ignoreRestSiblings: true }],
  'no-dupe-keys': 'error',
};

/**
 * Browser globals that are everyday variable names: a bare use is far more often
 * a variable that was never declared than the window's property, so `no-undef`
 * reports it, and a real use is written `window.x`.
 */
const NOT_GLOBAL_IN_FRONTEND = [
  'name', 'status', 'event', 'length', 'open', 'close', 'closed', 'top', 'parent',
  'origin', 'find', 'stop', 'focus', 'blur', 'print', 'scroll', 'external', 'screen',
];
const browser = Object.fromEntries(
  Object.entries(globals.browser).filter(([global]) => !NOT_GLOBAL_IN_FRONTEND.includes(global)),
);

export default [
  { ignores: ['**/node_modules/**', '**/dist/**'] },
  {
    linterOptions: { noInlineConfig: true },
  },
  {
    // ESM only: the CommonJS names (`require`, `__dirname`) are not globals here.
    files: ['backend/**/*.{js,mjs}'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: globals.nodeBuiltin },
    rules: correctness,
  },
  {
    // The wire's names, loaded by both packages: plain data, no globals.
    files: ['shared/**/*.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: {} },
    rules: correctness,
  },
  {
    files: ['frontend/src/**/*.{js,jsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: browser,
    },
    rules: { ...correctness, 'react-hooks/rules-of-hooks': 'error' },
  },
  {
    // The unit tests and their browser stand-ins run under Node.
    files: ['frontend/src/**/*.test.js', 'frontend/src/testing/**/*.js'],
    languageOptions: { globals: { ...globals.nodeBuiltin, ...browser } },
  },
];
