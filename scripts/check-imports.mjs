#!/usr/bin/env node
/**
 * Verify every relative import specifier under backend/src resolves to a real
 * file. Run with `npm run check-imports` from the repo root.
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
 */
import { access, readdir, readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('../backend/src/', import.meta.url));
const SPECIFIER = /['"](\.\.?\/[^'"\n]*\.m?js)['"]/g;

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

const files = (await collectSourceFiles(ROOT)).sort();
const unresolved = [];
let specifierCount = 0;

for (const file of files) {
  const source = await readFile(file, 'utf8');
  for (const match of source.matchAll(SPECIFIER)) {
    specifierCount += 1;
    const specifier = match[1];
    const target = fileURLToPath(new URL(specifier, pathToFileURL(file)));
    try {
      await access(target);
    } catch {
      // Line number from the match offset — cheaper than tracking it per line.
      const line = source.slice(0, match.index).split('\n').length;
      unresolved.push({ file, line, specifier, target });
    }
  }
}

for (const miss of unresolved) {
  console.error(`${path.relative(ROOT, miss.file)}:${miss.line}`);
  console.error(`  ${miss.specifier}  ->  ${miss.target}`);
}

const summary = `${specifierCount} relative specifiers across ${files.length} files`;
if (unresolved.length > 0) {
  console.error(`\n${unresolved.length} unresolved (${summary}).`);
  process.exit(1);
}
console.log(`OK — ${summary}, all resolve.`);
