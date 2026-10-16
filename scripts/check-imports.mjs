#!/usr/bin/env node
/**
 * Verify every relative import specifier under backend/src — plus the backend's
 * Node entry scripts (backend/scripts/*.mjs) and state migrations
 * (backend/migrations/) — resolves to a real file. Run with
 * `npm run check-imports` from the repo root.
 *
 * Why this exists: the backend is plain Node ESM with no build step and no test
 * suite, so nothing validates import paths ahead of runtime. Static imports at
 * least fail loudly at boot — but a *dynamic* import only resolves when its code
 * path runs, so a stale path can sit unnoticed until a user hits that one route.
 * That is exactly how `managedBridges.js` kept importing `../../vmManager.js`
 * after the manager relocation: VLAN bridge delete 500'd, create was fine, and
 * the backend started up perfectly.
 *
 * Deliberately a dumb string scan rather than a linter: it catches specifiers
 * ESLint's import/no-unresolved cannot see, including the literals inside the
 * platform ternaries the facades use —
 *   await import(platform() === 'linux' ? './linux/x.js' : './darwin/x.js')
 * — and JSDoc `import('./x.js')` type references. False positives are possible
 * in principle (any string that merely looks like a relative module path); none
 * exist today, and a real one is worth the noise.
 *
 * Frontend is not scanned: Vite already fails the build on unresolved imports,
 * and it resolves extensionless and aliased specifiers this scan does not model.
 *
 * Module-relative data paths get the same check: all-literal
 * `resolve(__dirname, '…')` / `join(__dirname, '…')` (in files whose `__dirname`
 * is the module's own directory) and `new URL('./…', import.meta.url)`. Such a
 * target names a bundled script, a protos dir, or a config file the app creates
 * at runtime, so it passes when the target exists **or its parent directory
 * does**. That catches the wrong-directory class — a `../` too few, a fallback
 * into a directory that was never there — but not a misspelled file name in a
 * real directory.
 */
import { access, readdir, readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const ROOTS = ['backend/src', 'backend/scripts', 'backend/migrations'].map((dir) => path.join(REPO_ROOT, dir));
const SPECIFIER = /['"](\.\.?\/[^'"\n]*\.m?js)['"]/g;
const DIRNAME_DEFINITION = /const __dirname = dirname\(fileURLToPath\(import\.meta\.url\)\)/;
const DIRNAME_PATH = /\b(?:resolve|join)\(\s*__dirname((?:\s*,\s*'[^'\n]*')+)(\s*,[^)\n]*)?\)/g;
const META_URL_PATH = /new URL\(\s*'(\.\.?\/[^'\n]*)'\s*,\s*import\.meta\.url\s*\)/g;

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function lineOf(source, index) {
  return source.slice(0, index).split('\n').length;
}

/**
 * Module-relative data paths: `[{ index, specifier, target, dirOnly }]`. A call
 * whose trailing arguments aren't literals (`join(__dirname, '../scripts', name)`)
 * checks its literal prefix, which must then exist itself.
 */
function dataPaths(file, source) {
  const found = [];
  if (DIRNAME_DEFINITION.test(source)) {
    for (const match of source.matchAll(DIRNAME_PATH)) {
      const parts = [...match[1].matchAll(/'([^'\n]*)'/g)].map((m) => m[1]);
      found.push({
        index: match.index,
        specifier: match[0],
        target: path.resolve(path.dirname(file), ...parts),
        dirOnly: match[2] !== undefined,
      });
    }
  }
  for (const match of source.matchAll(META_URL_PATH)) {
    found.push({
      index: match.index,
      specifier: match[0],
      target: fileURLToPath(new URL(match[1], pathToFileURL(file))),
      dirOnly: false,
    });
  }
  return found;
}

async function collectSourceFiles(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      found.push(...await collectSourceFiles(full));
    } else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) {
      found.push(full);
    }
  }
  return found;
}

const files = (await Promise.all(ROOTS.map(collectSourceFiles))).flat().sort();
const unresolved = [];
let specifierCount = 0;
let dataPathCount = 0;

for (const file of files) {
  const source = await readFile(file, 'utf8');
  for (const match of source.matchAll(SPECIFIER)) {
    specifierCount += 1;
    const specifier = match[1];
    const target = fileURLToPath(new URL(specifier, pathToFileURL(file)));
    if (!await exists(target)) {
      // Line number from the match offset — cheaper than tracking it per line.
      unresolved.push({ file, line: lineOf(source, match.index), specifier, target });
    }
  }
  for (const { index, specifier, target, dirOnly } of dataPaths(file, source)) {
    dataPathCount += 1;
    if (!await exists(target) && (dirOnly || !await exists(path.dirname(target)))) {
      unresolved.push({ file, line: lineOf(source, index), specifier, target });
    }
  }
}

for (const miss of unresolved) {
  console.error(`${path.relative(REPO_ROOT, miss.file)}:${miss.line}`);
  console.error(`  ${miss.specifier}  ->  ${miss.target}`);
}

const summary = `${specifierCount} relative specifiers and ${dataPathCount} module-relative paths across ${files.length} files`;
if (unresolved.length > 0) {
  console.error(`\n${unresolved.length} unresolved (${summary}).`);
  process.exit(1);
}
console.log(`OK — ${summary}, all resolve.`);
