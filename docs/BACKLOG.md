# Backlog

Pending small items, one entry each. Items that outgrow their entry graduate
to a plan in `docs/plans/` (see `CLAUDE.md` § Plans).

- **Sidebar: manual within-section workload ordering** — a third sort mode
  alongside alphabetical and online-first; the order lives on the section
  assignments so it is the single ordering shared by every consumer. Revisit
  when: the existing sorts demonstrably fight a real workflow — repeatedly
  hunting for a workload the sort keeps burying.
- **Live VM memory growth (balloon headroom / virtio-mem)** — wisp pins
  `<memory>` equal to `<currentMemory>`, so a running VM's RAM ceiling is its
  boot-time size and every increase costs a stop/start. Writing `<maxMemory>`
  above `<currentMemory>` and driving the virtio balloon (or virtio-mem) live
  would allow growth without restart. Semantics to design: how much headroom
  to define, guest cooperation, and what the Overview shows. Trigger observed
  2026-08-26: the play VM (4 GiB) OOM-killed a working agent session and the
  RAM bump required restarting everything inside. Revisit when: it happens
  again, or a memory bump needs to land on a VM that can't be restarted.
- **Optional SSO on Caddy hosts (Pocket ID)** — per-host auth toggle on the
  Caddy app's reverse-proxy records. Explored 2026-08-28/29, settled shape: a
  forward-auth gateway as a new wisp app container + `hosts[].sso` flag whose
  Caddyfile emission adds `forward_auth <gateway> { uri ... }` in the host's
  handle block (no Caddy image change — forward_auth is core Caddy;
  caddy-security in the custom image was considered and rejected: front-door
  blast radius, config surface, Pocket ID friction reports). Gateway choice is
  the open decision: **Tinyauth** (per-app group rules referencing Pocket ID
  groups via the `groups` claim — authz membership stays in Pocket ID; but NO
  bearer-token support, so machine clients need per-app API keys + per-host
  "SSO bypass paths" emitted as Caddy matchers) vs **oauth2-proxy**
  (`--skip-jwt-bearer-tokens` validates Pocket ID JWT access tokens for
  non-interactive clients; clunkier config, weaker per-app groups). Pocket ID
  admin-API client provisioning is optional sugar — one client total in the
  forward-auth model. Wisp wrinkles noted: TINYAUTH_AUTH_TRUSTEDPROXIES wants
  Caddy's (DHCP) IP; `hosts` is agent-writable via MCP so the sso flag needs
  the human-only treatment. Revisit when: the user schedules the auth session.
