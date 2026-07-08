/**
 * Wisp offline shell.
 *
 * Most Wisp installs sit behind a VPN, so the app is routinely launched with the
 * server unreachable. Launched from an iOS home-screen icon there is no Safari
 * chrome to render a "cannot connect" page — an uncached navigation just paints
 * white and strands the user, with no way to retry short of force-quitting. This
 * worker keeps the app shell so the launch always boots React, which then renders
 * `ServerUnreachable` (with a Retry button) instead of nothing.
 *
 * `BUILD_ID` and `PRECACHE_URLS` are placeholders rewritten into `dist/sw.js` by
 * `scripts/generate-sw-precache.js` at build time. `BUILD_ID` changes whenever the
 * hashed asset set changes, which both re-triggers install and scopes the cache
 * names so `activate` can purge the previous build's entries.
 *
 * Two strategies, deliberately no more:
 *   - navigations → network-first with a short timeout, falling back to the cached
 *     shell. Never cache-first: `wisp-updater` swaps `frontend/dist/` in place on
 *     self-update, and a cache-first shell would pin the user to a stale build.
 *   - /assets/*   → cache-first. Vite content-hashes these filenames, so every
 *     entry is immutable and a new build simply asks for new names.
 *
 * Everything else is left to the network: /api must never be served stale, /ws and
 * SSE streams must not pass through a cache, and /vendor (noVNC) is unhashed so a
 * cached copy would survive an update it shouldn't.
 */

const BUILD_ID = '__WISP_BUILD_ID__';

/** The entry chunk, its static imports, CSS, and fonts — everything React needs to
 *  boot far enough to render the offline screen. Lazy chunks (console, xterm) are
 *  deliberately excluded: they are only reachable with the server up. */
const PRECACHE_URLS = ['__WISP_PRECACHE_URLS__'];

const SHELL_CACHE = `wisp-shell-${BUILD_ID}`;
const ASSET_CACHE = `wisp-assets-${BUILD_ID}`;
const CURRENT_CACHES = [SHELL_CACHE, ASSET_CACHE];

/** Cache key for the SPA shell. The backend serves index.html for every non-/api
 *  path, so this single entry backs every client-side route. */
const SHELL_KEY = '/index.html';

/** How long a navigation waits for the server before falling back to the shell.
 *  With the VPN down the TCP connect to the reverse proxy typically hangs rather
 *  than being refused, so without this cap the launch would sit on a white screen
 *  for the OS connect timeout (~75 s on iOS). The cost of guessing too low is one
 *  load from a slightly stale shell, whose precached assets are all still present;
 *  the next online load refreshes it. */
const NAVIGATION_TIMEOUT_MS = 4000;

/** Last-resort page for a launch that finds neither network nor a cached shell
 *  (worker installed while offline, or the origin's storage was evicted). Inline
 *  styles only — `script-src 'self'` forbids inline scripts, so Retry is a plain
 *  link that re-triggers the navigation. */
const OFFLINE_FALLBACK_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Wisp — offline</title>
</head>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f6faf9;color:#0e1f1c;font-family:system-ui,-apple-system,sans-serif;">
<main style="max-width:22rem;padding:2rem;text-align:center;">
<h1 style="margin:0 0 .5rem;font-size:1.25rem;">Can't reach Wisp</h1>
<p style="margin:0 0 1.5rem;color:#4a5f5b;font-size:.875rem;line-height:1.5;">Your device can't reach the server. If you're away from home, connect to your VPN and try again.</p>
<a href="/" style="display:inline-block;padding:.5rem 1.25rem;border-radius:.5rem;background:#0fa396;color:#fff;font-size:.875rem;font-weight:500;text-decoration:none;">Retry</a>
</main>
</body>
</html>`;

function offlineFallbackResponse() {
  return new Response(OFFLINE_FALLBACK_HTML, {
    status: 503,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const shell = await caches.open(SHELL_CACHE);
      const assets = await caches.open(ASSET_CACHE);
      // Per-entry `catch`: a worker installed while the server is flaky must still
      // activate, or the user never gets an offline shell at all. `addAll` would
      // reject the whole batch on one bad response. Runtime caching fills any gap
      // on the next successful load.
      await Promise.all([
        shell.add(SHELL_KEY).catch(() => {}),
        ...PRECACHE_URLS.map((url) => assets.add(url).catch(() => {})),
      ]);
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith('wisp-') && !CURRENT_CACHES.includes(name))
          .map((name) => caches.delete(name))
      );
      await self.clients.claim();
    })()
  );
});

async function shellFromNetworkThenCache(request) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), NAVIGATION_TIMEOUT_MS);

  try {
    const response = await fetch(request, { signal: controller.signal });
    // Only a clean 200 is worth keeping. A 5xx error page would poison the shell,
    // and `cache.put` refuses a redirected response that a navigation later reads.
    if (response.ok && !response.redirected) {
      const cache = await caches.open(SHELL_CACHE);
      await cache.put(SHELL_KEY, response.clone());
    }
    return response;
  } catch {
    // Offline, or the server stayed silent past NAVIGATION_TIMEOUT_MS. Either way
    // the user gets a real page instead of a white screen.
    const cached = await caches.match(SHELL_KEY, { cacheName: SHELL_CACHE });
    return cached || offlineFallbackResponse();
  } finally {
    clearTimeout(timeout);
  }
}

async function assetFromCacheThenNetwork(request) {
  const cached = await caches.match(request, { cacheName: ASSET_CACHE });
  if (cached) return cached;

  // A miss here is a lazy chunk (console, xterm) or a build whose precache did not
  // complete. Deliberately no timeout: this is a normal network load, and cutting
  // it short would break a slow-but-working connection. The boot path never lands
  // here — those assets are precached at install.
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(ASSET_CACHE);
    await cache.put(request, response.clone());
  }
  return response;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Live data and streams: never intercepted, never cached. This must come before
  // the navigate branch — the OIDC sign-in flow navigates to /api/auth/oidc/login.
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/ws')) return;

  if (request.mode === 'navigate') {
    event.respondWith(shellFromNetworkThenCache(request));
    return;
  }

  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(assetFromCacheThenNetwork(request));
  }
});
