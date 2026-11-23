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

- The install and setup pipeline is `scripts/stage-release.sh` (the release-shaped
  tarball every host installs; hosts never build), `scripts/install.sh` and setup,
  `scripts/linux/setup/common-steps.sh` with its steps; keep a manual fix on a server to
  active debugging (`AGENTS.md`, Deployability).
- Cut **releases** with `scripts/release.sh` (version bumps, changelog fold, `v*` tag);
  pushing the tag to `github` runs the workflow that builds the release tarball.
- **Self-update is a first-class path**: an update is the new release's own install,
  with a way back ([`specs/UPDATES.md`](specs/UPDATES.md)).
- **A change that touches the install layout, persisted state, privileged helpers or the
  systemd templates keeps the updater's contract.** The recurring traps: a file a host
  must keep lives in `config/` or outside the install folder, because everything else
  there is replaced (the keep rule, UPDATES); a privileged helper is a file in
  `backend/scripts/`, installed and removed by setup; the unit templates are applied
  again on every update; only committed files ship in the release tarball.
- Run **dev deploys** through `scripts/push.sh`: it stages the release-shaped tarball,
  uploads it and runs its installer over SSH ([`specs/DEPLOYMENT.md`](specs/DEPLOYMENT.md)).
