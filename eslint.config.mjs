/**
 * ESLint, a dev-only tool of the repo root, run by `npm run lint` and `npm run
 * check`, over backend/, frontend/src/ and shared/. Correctness rules only
 * (docs/TECH-STACK.md, Testing & lint): no style rule. `react-hooks/exhaustive-deps`
 * is an error: every effect states its dependencies honestly, and one that cannot is
 * rewritten (the form hook owns what the sections' effects used to keep by hand).
 *
 * Inline config (`eslint-disable`, `/* global *\/`, `/* eslint … *\/`) is not
 * honoured, and `npm run lint` fails on the warning it leaves: an allowance, if
 * one is ever needed, is a reviewed line here, like the lists of the other checks.
 */
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';

import { CHANGE_KIND, JOB_KIND, TOPIC } from './shared/wireNames.js';

/**
 * The wire's names are written once, in shared/wireNames.js (docs/ARCHITECTURE.md,
 * Repo layout): everywhere else they are read from it, never written as a string. The
 * selectors below are built from that module, so a name added there is held at once.
 * A string or a template with no expression counts. One-word names (`vm`, `home`, …)
 * are everyday words, so they are refused only where a topic or a change kind goes:
 * the stream functions' and the store and record declarations' arguments, the
 * properties that carry one, a `changes` frame's `kind`, and a frame's `topic` or a
 * change's `kind` compared with one (`===`, `?.`, a `switch` case, `.includes` or
 * `.indexOf` over a list, `new Set([...]).has`), read plainly, through `?.` or as
 * `x['topic']`. A change is seen by its name: the variable holding it is named
 * `change`. These are the forms the rule sees, and the only ones. Every other — a name
 * built by concatenation or held in a variable, a change under another name, a
 * comparison not listed — is held at run time: the functions that take a topic or a
 * change kind refuse one that is not on the wire (`assertTopic`, `assertChangeKind`).
 */
const anyOf = (values) => `/^(?:${values.map((v) => v.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')).join('|')})$/`;
const JOB_KINDS = anyOf(Object.values(JOB_KIND));
const HYPHENATED_KINDS = anyOf(Object.values(CHANGE_KIND).filter((kind) => kind.includes('-')));
const STREAM_NAMES = anyOf([...Object.values(TOPIC), ...Object.values(CHANGE_KIND)]);
/** The functions whose arguments are topics or change kinds (a list of them included). */
const STREAM_CALLS = anyOf([
  'subscribeTopic', 'subscribeChanges', 'sendAndAwaitTopic', 'sendAndAwaitChange', 'sendAndAwaitKindChange',
  'topicSource', 'sendTopic', 'sendChange', 'latestGatherSender',
  'useRecord', 'createWorkloadStore',
]);
/** The properties whose value is a topic or a change kind. */
const NAME_PROPERTIES = anyOf(['topic', 'listTopic', 'changeKind', 'change']);
/** A literal naming `values`: a string, or a template with no expression. */
const named = (values) => [`Literal[value=${values}]`, `TemplateLiteral[expressions.length=0][quasis.0.value.cooked=${values}]`];
/** A frame's `topic`, or a change's `kind`, read at `at`: plainly, through `?.`, or
 *  computed (`x['topic']`). */
const READ_FORMS = (at, object, property) => [at, `${at}.expression`].flatMap((node) => [
  `[${node}${object ? `.object.name="${object}"][${node}` : ''}.property.name="${property}"]`,
  `[${node}${object ? `.object.name="${object}"][${node}` : ''}.property.value="${property}"]`,
]).join(', ');
const TOPIC_READ = (at) => READ_FORMS(at, null, 'topic');
const CHANGE_KIND_READ = (at) => READ_FORMS(at, 'change', 'kind');
const call = `:matches(CallExpression[callee.name=${STREAM_CALLS}], CallExpression[callee.property.name=${STREAM_CALLS}])`;

const WIRE_NAME_SELECTORS = [
  ...named(JOB_KINDS).map((selector) => ({ selector, message: 'A job kind is written once: use JOB_KIND (shared/wireNames.js).' })),
  ...named(HYPHENATED_KINDS).map((selector) => ({ selector, message: 'A change kind is written once: use CHANGE_KIND (shared/wireNames.js).' })),
  ...named(STREAM_NAMES).flatMap((literal) => [
    `${call} > ${literal}`,
    `${call} > ArrayExpression > ${literal}`,
    `${call} > ObjectExpression > Property[key.name="kind"] > ${literal}`,
    `Property[key.name=${NAME_PROPERTIES}] > ${literal}`,
    `ObjectExpression:has(> Property[key.name="topic"]) > Property[key.name="data"] > ObjectExpression > Property[key.name="kind"] > ${literal}`,
    ...[TOPIC_READ, CHANGE_KIND_READ].flatMap((read) => [
      `BinaryExpression:matches(${read('left')}) > ${literal}.right`,
      `BinaryExpression:matches(${read('right')}) > ${literal}.left`,
      `SwitchStatement:matches(${read('discriminant')}) > SwitchCase > ${literal}.test`,
      `CallExpression[callee.property.name=/^(?:includes|indexOf)$/]:matches(${read('arguments.0')}) > MemberExpression.callee > ArrayExpression.object > ${literal}`,
      `CallExpression[callee.property.name="has"]:matches(${read('arguments.0')}) > MemberExpression.callee > NewExpression.object[callee.name="Set"] > ArrayExpression > ${literal}`,
    ]),
  ].map((selector) => ({ selector, message: 'A topic or change kind is written once: use TOPIC or CHANGE_KIND (shared/wireNames.js).' }))),
];

const correctness = {
  'no-undef': 'error',
  'no-unused-vars': ['error', { ignoreRestSiblings: true }],
  'no-dupe-keys': 'error',
  'no-restricted-syntax': ['error', ...WIRE_NAME_SELECTORS],
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
    // The wire's names, loaded by both packages: plain data, no globals; the one
    // file that writes them.
    files: ['shared/**/*.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: {} },
    rules: { ...correctness, 'no-restricted-syntax': 'off' },
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
    /* A name that shadows another hides it: a row's variable named like a hook above it
     * reads the row's value where the hook's was meant. */
    rules: {
      ...correctness,
      'no-shadow': 'error',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
  {
    // The unit tests and their browser stand-ins run under Node.
    files: ['frontend/src/**/*.test.js', 'frontend/src/testing/**/*.js'],
    languageOptions: { globals: { ...globals.nodeBuiltin, ...browser } },
  },
];
