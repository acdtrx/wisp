# noVNC Integration

noVNC is the in-browser VNC client used for graphical console access to VMs. It is vendored (not installed via npm) due to bundler incompatibilities, and loaded via dynamic ESM import at runtime.

## Why Not npm?

The `@novnc/novnc` npm package uses top-level `await` in its CommonJS entry point. The build tool's bundler (Rollup) cannot process top-level `await` in CJS modules at build time. This causes build failures.

Rather than patching noVNC or adding complex build workarounds, the project vendors noVNC's raw ESM source files and serves them as static assets that are loaded at runtime, bypassing the bundler entirely.

## The vendored copy

- The copy is upstream noVNC's `core/` and `vendor/` directories, under `frontend/public/vendor/novnc/`. That tree is **not** committed: `scripts/vendor-novnc.sh` creates it.
- **Pinned to v1.7.0**, set in `scripts/vendor-novnc.sh` and nowhere else (settled 2026-11-18). The script checks that what it fetched is the pinned commit.
- **Every frontend build runs the vendor script first**, CI and the dev machine alike; hosts never build: the release tarball carries the built frontend (settled 2026-11-18).
- A tree that already holds the pinned copy is left alone. Any other is replaced by a swap, so the tree is never half there. One run at a time.
- A fetch or a commit check that fails fails the script, leaving the destination as it was, and the build fails with it.

## Loading and serving

- The bundler leaves every `/vendor/` import alone: the files are not processed, transpiled or bundled.
- The console loads noVNC at runtime by a dynamic import of `/vendor/novnc/core/rfb.js`.
- Both the development server and the production server serve `/vendor/*` as static files.
