/**
 * ESLint, a dev-only tool of the repo root, run by `npm run lint` and `npm run
 * check`. Correctness rules only (docs/TECH-STACK.md, Testing & lint): no style
 * rule. `react-hooks/exhaustive-deps` stays off until the hooks that own the
 * dependency arrays exist.
 */
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';

const correctness = {
  'no-undef': 'error',
  'no-unused-vars': ['error', { ignoreRestSiblings: true }],
  'no-dupe-keys': 'error',
};

export default [
  { ignores: ['**/node_modules/**', '**/dist/**'] },
  {
    linterOptions: { reportUnusedDisableDirectives: 'error' },
  },
  {
    files: ['backend/**/*.{js,mjs}'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: globals.node },
    rules: correctness,
  },
  {
    files: ['frontend/src/**/*.{js,jsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: globals.browser,
    },
    rules: { ...correctness, 'react-hooks/rules-of-hooks': 'error' },
  },
  {
    // The unit tests and their browser stand-ins run under Node.
    files: ['frontend/src/**/*.test.js', 'frontend/src/testing/**/*.js'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
];
