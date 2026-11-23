# LAN Discovery

Wisp instances on the same network discover each other via mDNS (Avahi). Each instance announces a `_wisp._tcp` service and browses for peers; discovered peers surface in the top bar as a dropdown next to the server name (see [UI.md](UI.md) § Top Bar).

## Announcement

Registered at boot, without waiting for it (a hung avahi never delays the listener), and re-registered when a successful `PATCH /api/settings` changes a discovery-relevant field (`serverName`, `discoveryEnabled`, `advertisedUrl`) — not on unrelated saves, since re-registering is a goodbye+announce on the wire. Reconciliation runs are serialized, so rapid toggle changes cannot interleave register/deregister. Gated by the `discoveryEnabled` setting (default on); disabling withdraws the service and stops browsing.

| Property | Value |
|----------|-------|
| Service type | `_wisp._tcp` |
| Instance name | Short host name (up to the first dot) — LAN-unique by mDNS convention. **Not** `serverName`, which defaults to "My Server" everywhere and would collide. |
| SRV target / port | `<hostname>.local` (A record published by avahi-daemon itself) : `WISP_PORT`. Containers on this host resolve the host's name through the DNS forwarder's host fast path (avahi's current name, answered from the containers' bridge addresses), not via avahi — see [CONTAINERS.md → Host's own name](CONTAINERS.md#resolution-in-process-dns-forwarder-on-1692545353). |
| TXT `url` | `advertisedUrl` setting if set, else `http://<hostname>.local:<port>`. Authoritative for navigation — behind a reverse proxy the SRV host/port are not reachable by browsers. |
| TXT `name` | `serverName` (display name shown in peers' dropdowns) |
| TXT `version` | Wisp version |

Re-announcing is a goodbye + announce on the wire, so peers see the service leave and come back, and resolve the new TXT.

## Browsing

- A service seen on several interfaces or protocols is one peer, gone only when its last sighting is.
- **A peer is resolved persistently, not once**, so a peer changing its advertised URL / name / version propagates live. A one-shot resolve would freeze the first TXT forever: a same-name re-registration updates records in place, and remote browsers see no remove and no new.
- Avahi restart, or a system bus that failed and was reopened ([CONTAINERS.md](CONTAINERS.md), Avahi restart recovery): announcements are re-registered, browsing starts over, and the peer list is dropped and re-learned.

## Self-filtering and peer-URL safety

A browsed service that avahi marks as this host's own is dropped, as is one carrying this host's instance name (for mDNS-reflector setups). A hypothetical second Wisp instance on the same host is therefore also filtered — the deployment model is one instance per host.

The peer's TXT `url` is attacker-controllable (any LAN device can announce `_wisp._tcp`) and ends up as a clickable link in the authenticated UI, so it is accepted only when it parses as `http`/`https`; otherwise the URL falls back to `http://<SRV host>:<SRV port>`, and peers with no usable URL are dropped.

## Peer list → frontend

The `discovery` topic of `GET /api/events` (SSE, cookie-authenticated like every `/api` route) sends the sorted peer list on connect, then on every change — no polling ([API-HOST.md](API-HOST.md) § Discovery). Peer shape:

```json
{ "name": "Other Box", "url": "http://otherbox.local:8080", "version": "1.3.0", "host": "otherbox.local" }
```

`name` falls back to the mDNS instance name when TXT `name` is missing; `url` falls back to `http://<host>:<port>` from the SRV record; `version` may be `null` (non-Wisp or older announcer).

## Settings

| Key | Default | Effect |
|-----|---------|--------|
| `discoveryEnabled` | `true` | Off: withdraw announcement, stop browsing, clear the peer list (peers' dropdowns drop this instance within seconds via the mDNS goodbye). |
| `advertisedUrl` | `null` | Overrides TXT `url` for reverse-proxied instances. Validated as `http`/`https` URL (422 `INVALID_URL` otherwise). Also pins the OIDC callback origin ([AUTH.md](AUTH.md) § OIDC). |

Both live in `wisp-config.json` ([CONFIGURATION.md](CONFIGURATION.md)) and are edited in **Host → App Config**.

## Limitations

- **Instance-name collisions are not handled.** Two hosts with the same short hostname → the second announcement never establishes; the collision is logged, and nothing is renamed. A group avahi leaves stuck probing after a Wisp-initiated interface removal is re-published — see [CONTAINERS.md → Stuck-probe recovery](CONTAINERS.md#publishing-avahi-daemon-via-dbus).
- **macOS dev:** darwin stubs — no announcement, no peers, no chevron.
- **TXT contents are public to the LAN** (server name, URL, version) — inherent to mDNS.
