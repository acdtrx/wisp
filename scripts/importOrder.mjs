/**
 * The import order of CODING-RULES §11, for check-imports.mjs: each file's import
 * declarations in three groups, in this order, with a blank line where one group
 * ends and the next begins:
 *   1. the platform: `node:` modules;
 *   2. packages: a bare or scoped name (`react`, `@xterm/xterm`);
 *   3. the project: a relative path.
 * Inside a group the order is free, and so are blank lines and comments.
 *
 * The declarations come from a real parse (ESLint's `Linter`, a dev dependency of
 * the repo root, with JSX on), so text that only looks like an import is not one; a
 * file that does not parse fails. Dynamic `import()` and `export … from` are not
 * imports here. The scope is every first-party script: the backend, its migrations
 * and helpers' tests, `shared/`, the frontend's source and build scripts, `scripts/`
 * and the root's configs; never `node_modules`, a build's output or vendored code.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { Linter } from 'eslint';

const TREES = ['backend', 'shared', 'frontend/src', 'frontend/scripts', 'scripts'];
const FILES = ['eslint.config.mjs', 'frontend/vite.config.js'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'vendor']);
const SCRIPT = /\.(?:m?js|jsx)$/;

const GROUP_NAMES = ['the platform (node:)', 'packages', 'the project (relative paths)'];

/** The group of an import's source: 0 platform, 1 package, 2 project. */
function groupOf(source) {
  if (source.startsWith('node:')) return 0;
  if (source.startsWith('.') || source.startsWith('/')) return 2;
  return 1;
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (SCRIPT.test(name)) out.push(full);
  }
  return out;
}

/** Every first-party script under `root`, sorted. */
export function importOrderFiles(root) {
  return [
    ...TREES.flatMap((tree) => walk(path.join(root, tree))),
    ...FILES.map((file) => path.join(root, file)),
  ].sort();
}

/** A file's import declarations, in source order: `{ source, start, end }` lines. */
function readImports(root, file, source) {
  const found = [];
  const linter = new Linter({ configType: 'flat', cwd: root });
  const messages = linter.verify(source, [{
    files: ['**/*.js', '**/*.mjs', '**/*.jsx'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', parserOptions: { ecmaFeatures: { jsx: true } } },
    plugins: {
      order: {
        rules: {
          imports: {
            create: () => ({
              ImportDeclaration(node) {
                found.push({ source: node.source.value, start: node.loc.start.line, end: node.loc.end.line });
              },
            }),
          },
        },
      },
    },
    rules: { 'order/imports': 'error' },
  }], { filename: file });
  /* A message of no rule is the linter's own: a file that does not parse, or one no
   * configuration matched (read as no imports, it would pass unread). */
  const own = messages.find((m) => m.ruleId === null);
  if (own) return { error: `was not read (line ${own.line ?? 0}): ${own.message}` };
  return { imports: found };
}

/** The problems of `files` under `root`: `{ file, line, message }` each. */
export function importOrderProblems(root, files) {
  const problems = [];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    const { imports, error } = readImports(root, file, source);
    if (error) {
      problems.push({ file, line: 0, message: error });
      continue;
    }
    const lines = source.split('\n');
    for (let i = 1; i < imports.length; i += 1) {
      const prev = imports[i - 1];
      const next = imports[i];
      const from = groupOf(prev.source);
      const to = groupOf(next.source);
      if (to < from) {
        problems.push({ file, line: next.start, message: `import of '${next.source}' (${GROUP_NAMES[to]}) comes after ${GROUP_NAMES[from]}` });
      } else if (to > from) {
        const between = lines.slice(prev.end, next.start - 1);
        if (!between.some((line) => line.trim() === '')) {
          problems.push({ file, line: next.start, message: `no blank line before the first import of ${GROUP_NAMES[to]} ('${next.source}')` });
        }
      }
    }
  }
  return problems;
}
