/**
 * Bakes the eager asset graph into dist/sw.js after a build.
 *
 * The service worker must precache exactly what React needs to boot and render the
 * offline screen. Relying on runtime caching alone is not enough: browsers may
 * serve subresources from their own HTTP cache without dispatching a fetch event,
 * so the worker's asset cache can stay sparse — and then an offline launch blanks.
 *
 * The list is resolved from Vite's build manifest (JSON) rather than by parsing
 * index.html, per CODING-RULES §4. Dynamic imports are excluded: the console and
 * xterm chunks are only reachable with the server up.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(root, 'dist');
const viteMetaDir = join(distDir, '.vite');
const manifestPath = join(viteMetaDir, 'manifest.json');
const swPath = join(distDir, 'sw.js');

function fail(message) {
  console.error(`generate-sw-precache: ${message}`);
  process.exit(1);
}

if (!existsSync(manifestPath)) fail(`missing ${manifestPath} — is build.manifest enabled in vite.config.js?`);
if (!existsSync(swPath)) fail(`missing ${swPath} — public/sw.js should have been copied into dist`);

const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
const entry = Object.values(manifest).find((chunk) => chunk.isEntry);
if (!entry) fail('no entry chunk in the vite manifest');

// Walk the entry's static import graph. `imports` can point back at the entry key,
// so `seen` guards the cycle. `dynamicImports` is intentionally not followed.
const urls = new Set();
const seen = new Set();

function collect(chunk) {
  if (!chunk || seen.has(chunk.file)) return;
  seen.add(chunk.file);

  urls.add(`/${chunk.file}`);
  for (const css of chunk.css ?? []) urls.add(`/${css}`);
  for (const asset of chunk.assets ?? []) urls.add(`/${asset}`);
  for (const imported of chunk.imports ?? []) collect(manifest[imported]);
}

collect(entry);

const precacheUrls = [...urls].filter((url) => url.startsWith('/assets/')).sort();
if (precacheUrls.length === 0) fail('resolved an empty precache list');

for (const url of precacheUrls) {
  if (!existsSync(join(distDir, url.slice(1)))) fail(`precache entry ${url} is not in dist`);
}

// Scopes the cache names. A changed asset set means a changed sw.js, which is what
// makes the browser install the new worker and lets activate purge the old caches.
const buildId = createHash('sha256').update(precacheUrls.join('\n')).digest('hex').slice(0, 12);

const source = readFileSync(swPath, 'utf-8');
if (!source.includes("'__WISP_BUILD_ID__'") || !source.includes("['__WISP_PRECACHE_URLS__']")) {
  fail('sw.js is missing its __WISP_BUILD_ID__ / __WISP_PRECACHE_URLS__ placeholders');
}

const generated = source
  .replace("'__WISP_BUILD_ID__'", JSON.stringify(buildId))
  .replace("['__WISP_PRECACHE_URLS__']", JSON.stringify(precacheUrls));

writeFileSync(swPath, generated);

// The manifest is a build input, not something to ship or serve.
rmSync(viteMetaDir, { recursive: true, force: true });

console.log(`generate-sw-precache: build ${buildId}, precaching ${precacheUrls.length} assets`);
