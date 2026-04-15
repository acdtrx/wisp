# Changelog

## 2026-04-15

### New Features
- Container secret env vars with structured shape and envPatch delta updates
- OCI image picker and local-image shortcut on container create
- CNI bridge networking for containers so the host can reach them
- Session vs all logs for containers (persisted session start offset)
- Interactive container shell console (xterm + containerd exec)

### Bug Fixes
- Pass container MAC under `args.cni.mac` for bridge CNI
- Icon-only Browse button on container image field
- Reliable favicon transparency on Safari
- Use upstream `resolv.conf` for container DNS on systemd-resolved hosts

### Docs
- README reframed around the homelab-focused, opinionated-simplicity intent
- Project rules migrated to `CLAUDE.md` (root + scoped `backend/src/lib` and `backend/src/routes`)
- Added changelog workflow: `CHANGELOG.md` updated before every push

## Initial release
- First commit; baseline Wisp VM and container management app.
