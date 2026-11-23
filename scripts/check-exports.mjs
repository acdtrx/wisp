#!/usr/bin/env node
/**
 * Every export under frontend/src is imported somewhere: an export nothing imports
 * is dead code that reads as API. Run with `npm run check-exports` from the repo root;
 * `npm run check` runs it.
 *
 * It reads each file's imports and exports from a real parse: ESLint's `Linter` (a dev
 * dependency of the repo root already) runs a rule defined here over every file, with
 * JSX on, and the rule collects the import and export nodes. A file that does not parse
 * fails the check. Specifiers resolve as Vite does for these files (the path, then
 * `.js`, `.jsx`, `/index.js`); the unit tests count as importers (pure code is exported
 * to be tested). Named exports, destructured ones included, `export { … }`,
 * `export … from` (a use of the target's names) and `export default` are read; a
 * module's `export * from` counts every export of its target as used. A dynamic
 * `import()` of a relative path written out whole (a string, or a template whose path has
 * no expression in it: an expression only in a `?` query after the path, as the unit
 * tests' fresh loads write it, leaves the path whole) counts every export of its target
 * as used; one Vite is told to leave alone
 * (`/* @vite-ignore *\/`) is a runtime URL, no module of ours. Any other dynamic import
 * — a path with an expression in it, or not a path — is one the check cannot follow: it
 * fails the check, naming the line. A file the linter does not read (no matching
 * configuration, ignored) fails it too.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Linter } from 'eslint';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const ROOT = fileURLToPath(new URL('../frontend/src/', import.meta.url));

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(js|jsx)$/.test(name)) out.push(full);
  }
  return out;
}

function resolve(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec.replace(/\?.*$/, ''));
  for (const candidate of [base, `${base}.js`, `${base}.jsx`, path.join(base, 'index.js')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** The names a binding pattern declares (`a`, `{ a, b: c }`, `[a, ...b]`). */
function boundNames(pattern) {
  switch (pattern?.type) {
    case 'Identifier': return [pattern.name];
    case 'ObjectPattern': return pattern.properties.flatMap((p) => boundNames(p.type === 'RestElement' ? p.argument : p.value));
    case 'ArrayPattern': return pattern.elements.flatMap((e) => boundNames(e));
    case 'RestElement': return boundNames(pattern.argument);
    case 'AssignmentPattern': return boundNames(pattern.left);
    default: return [];
  }
}

const nameOf = (node) => (node.type === 'Identifier' ? node.name : String(node.value));

/** What one file exports and imports, read by a rule over its parse. */
function read(file, linter) {
  const found = { exports: new Set(), imports: [], problems: [] };
  const at = (node) => `${path.relative(ROOT, file)}:${node.loc.start.line}`;
  const use = (spec, name) => { if (spec.startsWith('.')) found.imports.push({ spec, name }); };
  const collect = {
    create(context) {
      return {
        ImportDeclaration(node) {
          const spec = node.source.value;
          for (const s of node.specifiers) {
            if (s.type === 'ImportDefaultSpecifier') use(spec, 'default');
            else if (s.type === 'ImportNamespaceSpecifier') use(spec, '*');
            else use(spec, nameOf(s.imported));
          }
        },
        ExportNamedDeclaration(node) {
          if (node.declaration) {
            const d = node.declaration;
            const names = d.type === 'VariableDeclaration' ? d.declarations.flatMap((v) => boundNames(v.id)) : [d.id.name];
            for (const name of names) found.exports.add(name);
          }
          for (const s of node.specifiers) {
            found.exports.add(nameOf(s.exported));
            if (node.source) use(node.source.value, nameOf(s.local));
          }
        },
        ExportDefaultDeclaration() { found.exports.add('default'); },
        ExportAllDeclaration(node) {
          use(node.source.value, '*');
          if (node.exported) found.exports.add(nameOf(node.exported));
        },
        ImportExpression(node) {
          const src = node.source;
          const ignored = context.sourceCode.getCommentsBefore(src).some((c) => /@vite-ignore/.test(c.value));
          /* A path counts only written out whole: a string, or a template whose path (up to
           * a `?` query) has no expression in it. */
          const head = src.type === 'TemplateLiteral' ? src.quasis[0].value.cooked : null;
          const text = src.type === 'Literal' && typeof src.value === 'string' ? src.value
            : head != null && (src.expressions.length === 0 || head.includes('?')) ? head.split('?')[0] : null;
          if (text != null && text.startsWith('.')) use(text, '*');
          else if (!ignored) found.problems.push(`${at(node)}: a dynamic import this check cannot follow`);
        },
      };
    },
  };
  const messages = linter.verify(readFileSync(file, 'utf8'), {
    files: ['**/*.js', '**/*.jsx'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', parserOptions: { ecmaFeatures: { jsx: true } } },
    plugins: { exports: { rules: { collect } } },
    rules: { 'exports/collect': 'error' },
  }, { filename: file });
  for (const m of messages) {
    /* A file the linter did not read (ignored, or outside its configuration) is no pass. */
    if (m.fatal) found.problems.push(`${path.relative(ROOT, file)}:${m.line ?? 0}: not read: ${m.message}`);
    else if (m.ruleId == null) found.problems.push(`${path.relative(ROOT, file)}: not read: ${m.message}`);
  }
  return found;
}

/* Rooted at the repo, wherever the check is run from: its configuration matches every
 * file by its path from there. */
const linter = new Linter({ configType: 'flat', cwd: REPO_ROOT });
const files = walk(ROOT);
const read_ = new Map(files.map((file) => [file, read(file, linter)]));
const used = new Map();
const problems = [];
for (const [file, found] of read_) {
  problems.push(...found.problems);
  for (const { spec, name } of found.imports) {
    const target = resolve(file, spec);
    if (!target) continue; // not a module of ours (an asset): the build checks it
    if (!used.has(target)) used.set(target, new Set());
    used.get(target).add(name);
  }
}
const unused = [];
for (const [file, found] of read_) {
  const seen = used.get(file) ?? new Set();
  if (seen.has('*')) continue;
  for (const name of found.exports) if (!seen.has(name)) unused.push(`${path.relative(ROOT, file)}: ${name}`);
}

if (problems.length > 0 || unused.length > 0) {
  for (const line of problems) console.error(`exports: ${line}`);
  if (unused.length > 0) {
    console.error(`exports: ${unused.length} export(s) under frontend/src that nothing imports:`);
    for (const line of unused) console.error(`  ${line}`);
  }
  process.exit(1);
}
console.log(`exports: every export of ${files.length} files under frontend/src is imported.`);
