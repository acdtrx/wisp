/**
 * Fails the build when chunks import each other statically in a loop.
 *
 * In an ES module cycle one chunk runs before the chunk it imports from has run,
 * so a top-level call into it hits an undefined binding and the page boots blank.
 * The static import graph is read from Vite's build manifest (CODING-RULES §4);
 * dynamic imports are not edges here, since they run after both chunks loaded.
 * Runs before generate-sw-precache.js, which deletes the manifest.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(root, 'dist', '.vite', 'manifest.json');

if (!existsSync(manifestPath)) {
  console.error(`check-chunk-cycles: missing ${manifestPath} — is build.manifest enabled in vite.config.js?`);
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
const done = new Set();
const path = [];

function visit(key) {
  const at = path.indexOf(key);
  if (at !== -1) {
    const loop = [...path.slice(at), key].map((k) => manifest[k]?.file ?? k);
    console.error(`check-chunk-cycles: chunks import each other in a loop: ${loop.join(' -> ')}`);
    process.exit(1);
  }
  if (done.has(key)) return;
  path.push(key);
  for (const next of manifest[key]?.imports ?? []) visit(next);
  path.pop();
  done.add(key);
}

for (const key of Object.keys(manifest)) visit(key);
console.log(`check-chunk-cycles: ${Object.keys(manifest).length} chunks, no static import cycles`);
