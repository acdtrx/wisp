# Production

What a project facing real users or a network adds to the rules.

## Security

- Rate-limit authentication and other sensitive endpoints.
  - Applied: failed logins and invalid bearer tokens share one per-IP window (60 s,
    5 attempts), keyed on `request.ip` only — no `x-forwarded-for` fallback.
- Make sessions `HttpOnly`, `Secure`, `SameSite` cookies; reject cross-site requests on
  state-changing routes. Store passwords only as a slow hash.
  - Applied: `Secure` is set when the request arrived over HTTPS — a plain-HTTP LAN
    install would otherwise lose its cookies; state-changing requests carry the
    double-submit CSRF token; the password is a scrypt hash
    ([`specs/AUTH.md`](specs/AUTH.md)).
- Set the standard security headers; keep CORS off, since the app serves its own client.
  Cap request bodies and uploads.
  - Applied: CSP, `nosniff`, `X-Frame-Options: DENY` and `Referrer-Policy: same-origin`
    on every response; CORS only for the Vite dev server in development; multipart
    uploads capped at 50 GB, and a per-route `bodyLimit` where a route takes more than
    Fastify's default.

## Backups `[PROJECT]`

- Wisp backs up workloads, not itself: VM backups on demand, container backups on demand
  and on a daily schedule with retention, to local and SMB destinations
  ([`specs/BACKUPS.md`](specs/BACKUPS.md)). Its own `config/` (settings, the password
  hash, the migration ledger) is not backed up; whether it should be is a backlog entry.
  Host-level mirroring is per-deployment infrastructure.

## Deploys `[PROJECT]`

- The install and setup pipeline is `scripts/install.sh`, `scripts/setup-server.sh` and
  `scripts/linux/setup/`; keep a manual fix on a server to active debugging (`AGENTS.md`,
  Deployability).
- Cut **releases** with `scripts/release.sh` (version bumps, changelog fold, `v*` tag);
  pushing the tag to `github` runs the workflow that builds the release tarball.
- **Self-update is a first-class path**: `wisp-updater` swaps the install atomically from
  a GitHub release, runs the shared setup steps (`common-steps.sh`: container DNS,
  helpers, then the state migrations, with the backend stopped), re-templates the systemd
  unit, starts Wisp and waits for its health check, and rolls the whole tree back when a
  step fails ([`specs/UPDATES.md`](specs/UPDATES.md)).
- **A change that touches the install layout, persisted state, privileged helpers or the
  systemd templates keeps the updater's contract.** The recurring traps: a persisted file
  inside the install tree needs the updater's preserve list; a new privileged `wisp-*`
  helper must be registered in `scripts/linux/setup/install-helpers.sh` or it vanishes on
  the next self-update; the `wisp.service` template is re-applied from the repo on every
  update; only committed files ship in the release tarball.
- Run **dev deploys** through `scripts/push.sh`: it packages a zip, uploads it and runs
  the installer over SSH ([`specs/DEPLOYMENT.md`](specs/DEPLOYMENT.md)).
