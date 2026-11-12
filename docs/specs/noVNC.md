# noVNC Integration

noVNC is the in-browser VNC client used for graphical console access to VMs. It is vendored (not installed via npm) due to bundler incompatibilities, and loaded via dynamic ESM import at runtime.

## Why Not npm?

The `@novnc/novnc` npm package uses top-level `await` in its CommonJS entry point. The build tool's bundler (Rollup) cannot process top-level `await` in CJS modules at build time. This causes build failures.

Rather than patching noVNC or adding complex build workarounds, the project vendors noVNC's raw ESM source files and serves them as static assets that are loaded at runtime, bypassing the bundler entirely.

## Vendored Files

noVNC source files are placed in:

```
frontend/public/vendor/novnc/
├── core/              # noVNC ESM source modules
│   ├── rfb.js         # Main RFB (Remote Framebuffer) module — the entry point
│   ├── display.js
│   ├── websock.js
│   └── ...            # Other internal modules
└── vendor/
    └── pako/          # Compression library used by noVNC (bundled with noVNC upstream)
```

These are copies of the `core/` and `vendor/` directories from the upstream [noVNC GitHub repository](https://github.com/novnc/noVNC). The `frontend/public/vendor/` tree is **not** committed (see root `.gitignore`); it is created by `vendor-novnc.sh` or `ensure-novnc.js`.

## Vendor Script

`scripts/vendor-novnc.sh` handles populating the vendor directory:

1. Takes a destination directory as argument (e.g. `frontend/public/vendor/novnc`)
2. Checks if `core/rfb.js` and `vendor/pako` already exist — skips if so
3. Does a shallow `git clone` of the noVNC repository to a temp directory
4. Copies `core/` and `vendor/` to the destination
5. Cleans up the temp directory
6. Warns if the clone fails (network/git issues) — VNC console will not work but the app still builds

## Prebuild Check

`frontend/scripts/ensure-novnc.js` runs before every production build (via `npm run build`):

```
node scripts/ensure-novnc.js && vite build
```

This script ensures noVNC files are present before the build starts. If they're missing, it triggers the vendor script.

## Build Configuration

The Vite config externalizes all `/vendor/` paths from Rollup's bundling:

```js
build: {
  rollupOptions: {
    external: [/^\/vendor\//],
  },
}
```

This tells the bundler to leave any `import('/vendor/...')` calls as-is in the output, rather than trying to resolve and bundle them.

Since the vendor files are in `public/`, they are served as-is by both the development server and the production static file server. They are not processed, transpiled, or bundled.

## Runtime Loading

The VNC console component uses a dynamic import to load noVNC at runtime:

```js
const rfbUrl = '/vendor/novnc/core/rfb.js';

let RFBClass = null;
const loadPromise = import(/* @vite-ignore */ rfbUrl)
  .then((m) => { RFBClass = m.default; })
  .catch((err) => console.error('Failed to load noVNC:', err));
```

When connecting to a VM:

1. `await loadPromise` — ensures noVNC is loaded
2. Create an `RFB` instance: `new RFBClass(viewportElement, wsUrl, { shared: true })`
3. The RFB instance manages the VNC protocol, rendering, and input events

The `/* @vite-ignore */` comment tells Vite not to try to analyze or transform this import.

## Production Serving

The frontend production server explicitly serves the vendor directory:

```
/vendor/* → frontend/public/vendor/
```

This is registered as a separate static file route to ensure noVNC is available even if the `dist/` build output doesn't include it.

## Updating noVNC

To update noVNC:

1. Delete `frontend/public/vendor/novnc/`
2. Run `scripts/vendor-novnc.sh frontend/public/vendor/novnc`
3. The script clones the latest noVNC and copies `core/` and `vendor/`
4. Rebuild the frontend

No other changes are needed — the dynamic import path remains the same.

## ESLint

The vendored files in `public/vendor/` are outside ESLint's scope and do not trigger linting. No ESLint configuration changes are needed.
