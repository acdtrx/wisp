# MCP Endpoint

Wisp exposes a **Model Context Protocol** server at **`POST /mcp`** so coding agents (Claude Code and other MCP clients) can inspect the deployment — what runs, on which IPs and names, how apps are configured, what the host looks like — without API docs in context.

Implementation: `backend/src/lib/mcp/mcpServer.js` (JSON-RPC dispatch), `backend/src/lib/mcp/tools/` (tool catalogue), `backend/src/routes/mcp.js` (HTTP surface). Hand-rolled, no SDK dependency — same precedent as the in-house JWT and OIDC implementations.

## Transport and protocol subset

Streamable HTTP in **stateless, single-JSON-response mode** (permitted by the MCP spec): every client message is a `POST /mcp` with a JSON-RPC 2.0 body, answered with `application/json`. There is **no SSE stream** (`GET /mcp` → 405), **no session id**, and **no server-initiated messages** — tools return snapshots, which is what agents want.

| Method | Behaviour |
|--------|-----------|
| `initialize` | Returns `protocolVersion: "2025-06-18"`, `capabilities: { tools: {} }`, `serverInfo` (`name: "wisp"`, current version), and an `instructions` string describing the host model |
| `notifications/*` (any message without an `id`) | Accepted with **202**, no body |
| `ping` | `{}` |
| `tools/list` | Tool catalogue **filtered to what the token's scope can call** (no pagination — the list is small) |
| `tools/call` | Runs the tool; success returns `structuredContent` (JSON) plus a stringified `text` content block; tool failures return `isError: true` with the standard `{ error, detail, code }` as text |
| anything else | JSON-RPC error `-32601` |

JSON-RPC batching is rejected (`-32600`; removed from the MCP spec in 2025-06-18). Malformed JSON is rejected by Fastify's body parser before reaching the MCP layer.

## Authentication

`/mcp` accepts **only bearer API tokens** ([AUTH.md](AUTH.md) § API tokens). Cookies are ignored entirely, which also makes the endpoint CSRF-irrelevant. A missing or invalid token gets **401** with `WWW-Authenticate: Bearer`; invalid tokens feed the shared per-IP auth rate limit.

**Scope model:** the REST hook's method gate (read = GET/HEAD) does not apply on `/mcp` — MCP is JSON-RPC over POST, so the HTTP method says nothing about mutation. Instead each tool declares a required scope; `tools/list` hides tools above the token's scope and `tools/call` double-checks. All phase-1 tools are `read`-scoped, so a read-only token is the right default for agents.

## Tools (phase 1 — all read-only)

| Tool | Input | Returns |
|------|-------|---------|
| `get_deployment_overview` | — | wisp version, serverName, host identity, bridges, sections; per-container `{ name, state, image, ip, bridge, mdnsName, app, autostart, restartPolicy, updateAvailable }`; per-VM `{ name, state, vcpus, memoryMiB, autostart, ip, guestHostname, mdnsName }` |
| `get_container` | `{ name }` | Full container config + state with **all secrets masked** — including `metadata.app` and the masked `appConfig`. This is how agents read app configuration generically (e.g. a Caddy container's `appConfig.hosts[]` = the exposure map); there are deliberately no app-specific tools |
| `get_container_logs` | `{ name, lines?, runId? }` | Tail of a run log (newest run by default; `lines` 1–1000, default 100) |
| `list_images` | — | Images in the `wisp` containerd namespace, containers with a newer digest available, last update-check info |
| `get_vm` | `{ name }` | Full VM config plus `guestNetwork` (qemu-guest-agent; nulls without it) and `snapshots` |
| `get_host_stats` | — | One sample of the `/api/stats` SSE payload (shared builder `lib/hostStatsSnapshot.js`) |
| `get_host_hardware` | — | Static inventory from `getHostHardwareInfo()`: CPU topology, DMI, RAM modules, disks + SMART, PCI, GPUs |

Tool handlers call the same facades and glue as the REST routes (`containerManager`, `vmManager`, `lib/host`, `lib/containerApps`, settings) and go through the same masking (`maskContainerConfigSecrets`) — no tool output ever contains a secret. Container names are validated (`validateContainerName`) before any path-derived read.

## Client registration

```bash
# Claude Code (user scope — available in every project)
claude mcp add --scope user --transport http wisp \
  https://wisp.anapana.trixbits.ro/mcp \
  --header "Authorization: Bearer wisp_read_…"
```

Any streamable-HTTP MCP client works the same way: point it at `https://<wisp-host>/mcp` with the `Authorization` header. Create the token in **Host → App Config → API tokens** (`read` scope suffices for all current tools). TLS comes from the reverse proxy in front of Wisp; on the LAN, `http://<host>:8080/mcp` works too.

## Design rules

- **No app-specific tools.** Multiple instances of an app can exist (several Caddy containers); nothing may assume a singleton. App config is read via `get_container`'s masked `appConfig`.
- **No consoles, no secrets, no writes** in phase 1. Mutating tools (`deploy_container`, lifecycle, `check_image_updates`) are phase 3 of `docs/plans/wisp-mcp.md`, gated on `admin` scope.
- **Stateless on purpose.** Nothing to resume, no session table, restarts are invisible to clients.
