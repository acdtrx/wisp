# LAN Discovery

Wisp instances on the same network discover each other via mDNS (Avahi). Each instance announces a `_wisp._tcp` service and browses for peers; discovered peers surface in the top bar as a dropdown next to the server name (see [UI.md](UI.md) § Top Bar).

Module layout follows the mdns rules: all Avahi DBus code lives in `backend/src/lib/mdns/linux/avahi.js` (generic, type-agnostic browse surface `subscribeServiceBrowse`); Wisp policy — what to announce, self-filtering, the peer map — lives in the app-glue module `backend/src/lib/wispDiscovery.js`. macOS dev is a no-op (darwin stubs): nothing announces, the peer list stays empty.

## Announcement

Registered at boot (`startWispDiscovery`, after `connectMdns`, fire-and-forget so a hung avahi never delays `app.listen`) and re-registered when a successful `PATCH /api/settings` changes a discovery-relevant field (`serverName`, `discoveryEnabled`, `advertisedUrl`) — not on unrelated saves, since re-registering is a goodbye+announce on the wire. Reconciliation runs are serialized, so rapid toggle changes cannot interleave register/deregister. Gated by the `discoveryEnabled` setting (default on); disabling withdraws the service and stops browsing.

| Property | Value |
|----------|-------|
| Service type | `_wisp._tcp` |
| Instance name | Short host name (`os.hostname()` up to the first dot) — LAN-unique by mDNS convention. **Not** `serverName`, which defaults to "My Server" everywhere and would collide. |
| SRV target / port | `<hostname>.local` (A record published by avahi-daemon itself) : `WISP_PORT` |
| TXT `url` | `advertisedUrl` setting if set, else `http://<hostname>.local:<port>`. Authoritative for navigation — behind a reverse proxy the SRV host/port are not reachable by browsers. |
| TXT `name` | `serverName` (display name shown in peers' dropdowns) |
| TXT `version` | Wisp version (`getCurrentVersion()` from `wispUpdate.js`) |

Re-announcing frees the old Avahi entry group and commits a new one — on the wire that is a goodbye + announce, so peers see `ItemRemove` + `ItemNew` and re-resolve the new TXT.

## Browsing

`subscribeServiceBrowse(type, { onUp, onDown, onReset })` in the mdns module:

- One Avahi `ServiceBrowser` per service type (`IF_UNSPEC`/`PROTO_UNSPEC`), shared across subscribers; freed when the last subscriber leaves.
- Signals are dispatched at the raw bus level (dbus-next `bus.on('message')`) and routed by object path. Avahi emits signals immediately after the `*New` method returns — signals for a not-yet-registered path are buffered while a creation is in flight so none are lost to the proxy-introspection race.
- The same service is reported once per interface and protocol; sightings are refcounted per `(interface, protocol)` pair — `onUp` fires on the first sighting, `onDown` only when the last one is removed.
- Resolution uses a **persistent `ServiceResolver` per instance name** (freed when the service leaves or the browser resets). Avahi re-emits `Found` whenever the service's records change, so a peer changing its advertised URL / name / version propagates live as a fresh `onUp` — a one-shot resolve would freeze the first TXT forever, because a same-name re-registration updates records in place without any `ItemRemove`/`ItemNew` on remote browsers.
- Avahi restart (`NameOwnerChanged`): announcements are re-registered, browsers re-created (resolvers follow via fresh `ItemNew`s), and subscribers get `onReset` (drop everything) followed by fresh `onUp` events as peers are re-learned.

## Self-filtering and peer-URL safety

Browsed services carry a normalized `isLocal` flag (computed inside the linux impl from avahi's lookup-result bits `LOCAL`/`OUR_OWN` — the wire flags never leave the mdns module). `wispDiscovery.onUp` drops `isLocal` services, plus a belt-and-braces instance-name check for mDNS-reflector setups. A hypothetical second Wisp instance on the same host is therefore also filtered — the deployment model is one instance per host.

The peer's TXT `url` is attacker-controllable (any LAN device can announce `_wisp._tcp`) and ends up as a clickable link in the authenticated UI, so it is accepted only when it parses as `http`/`https`; otherwise the URL falls back to `http://<SRV host>:<SRV port>`, and peers with no usable URL are dropped.

## Peer list → frontend

The `discovery` topic of `GET /api/events` (SSE, cookie-authenticated like every `/api` route) sends the sorted peer list on connect, then on every change — no polling ([API.md](API.md) § Discovery). Peer shape:

```json
{ "name": "Other Box", "url": "http://otherbox.local:8080", "version": "1.3.0", "host": "otherbox.local" }
```

`name` falls back to the mDNS instance name when TXT `name` is missing; `url` falls back to `http://<host>:<port>` from the SRV record; `version` may be `null` (non-Wisp or older announcer).

Frontend: `store/discoveryStore.js` subscribes via `createSSE`; `components/layout/ServerSwitcher.jsx` (mounted in the top bar) owns the subscription lifecycle and renders the dropdown only when peers exist.

## Settings

| Key | Default | Effect |
|-----|---------|--------|
| `discoveryEnabled` | `true` | Off: withdraw announcement, stop browsing, clear the peer list (peers' dropdowns drop this instance within seconds via the mDNS goodbye). |
| `advertisedUrl` | `null` | Overrides TXT `url` for reverse-proxied instances. Validated as `http`/`https` URL (422 `INVALID_URL` otherwise). |

Both live in `wisp-config.json` ([CONFIGURATION.md](CONFIGURATION.md)) and are edited in **Host → App Config**.

## Limitations

- **Instance-name collisions are not handled** (pre-existing mdns-module gap: no EntryGroup `StateChanged` listener). Two hosts with the same short hostname → the second announcement silently never establishes.
- **macOS dev:** darwin stubs — no announcement, no peers, no chevron.
- **TXT contents are public to the LAN** (server name, URL, version) — inherent to mDNS.
