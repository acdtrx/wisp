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

These are copies of the `core/` and `vendor/` directories from the upstream [noVNC GitHub repository](https://github.com/novnc/noVNC). The `frontend/public/vendor/` tree is **not** committed (see root `.gitignore`); it is created by `vendor-novnc.sh`.

**Pinned to v1.7.0**, set in `scripts/vendor-novnc.sh` and nowhere else (settled 2026-11-18).

## Vendor Script

`scripts/vendor-novnc.sh` handles populating the vendor directory:

1. Takes no argument: its target is always `frontend/public/vendor/novnc`, and one run at a time holds the lock directory `frontend/public/vendor/.novnc.lock` (a second run fails on it)
2. Skips the fetch when the destination's `.pinned` file names the pinned tag and commit and `core/rfb.js` and `vendor/pako` are there
3. Otherwise does a shallow `git clone` of the pinned tag to a temp directory and checks the checkout is the pinned commit
4. Copies `core/` and `vendor/` into a staging directory beside the target, writes `.pinned`, and swaps it in by rename (the old tree moved aside, the new one moved in, the old one removed), so a tree holding any other copy ends up with the pinned one and is never half there
5. Fails (exit 1, with the cause) if the clone or the commit check fails, leaving the destination as it was — the build fails with it

## Prebuild Step

The frontend's `npm run build` runs the vendor script before `vite build`, so every build goes through it — CI and the dev machine (hosts never build: the release tarball carries the built frontend, settled 2026-11-18):

```
bash ../scripts/vendor-novnc.sh && vite build
```

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

1. Set the new release's tag and commit in `scripts/vendor-novnc.sh`, and the version in the **Pinned to** line above
2. Rebuild the frontend: the script sees the tree holds another version and fetches the new one

No other changes are needed — the dynamic import path remains the same.

## ESLint

The vendored files in `public/vendor/` are outside ESLint's scope and do not trigger linting. No ESLint configuration changes are needed.
