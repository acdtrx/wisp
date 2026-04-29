# Console

The console provides in-browser graphical access to running VMs via VNC. It uses a WebSocket proxy architecture where the browser's VNC client communicates with QEMU's VNC server through the backend.

## Architecture

```
Browser (noVNC) ──WebSocket──> Backend WS Proxy ──TCP──> QEMU VNC (127.0.0.1:port)
```

1. The browser establishes a WebSocket connection to `/ws/console/:name/vnc?token=<jwt>`
2. The backend verifies the JWT token from the query parameter
3. The backend reads the VM's domain XML to extract the VNC port from the `<graphics>` element
4. The backend opens a TCP connection to `127.0.0.1:<port>`
5. Data flows bidirectionally: WebSocket frames are written to the TCP socket and TCP data is sent as WebSocket frames

## VNC Port Discovery

The VNC port is not hardcoded — it is dynamically assigned by QEMU and discovered at connection time by parsing the domain XML:

```xml
<graphics type='vnc' port='5900' autoport='yes' listen='127.0.0.1'/>
```

The backend extracts the `port` attribute from the `<graphics type='vnc'>` element via `getVNCPort(name)`.

## Authentication

WebSocket connections cannot carry `Authorization` headers during the handshake. Instead, the JWT is passed as a query parameter (`?token=`). The console route verifies the token before establishing the proxy connection.

The route also enforces a same-origin policy on the upgrade request before the JWT check. CORS does not apply to WebSocket, so without this an attacker page on any origin could open a WS to `/ws/console/...` and (with a stolen JWT) drive the VM. In dev, only `http://localhost:5173` is allowed; in production, `Origin`'s host must equal the request `Host` header. Extra origins can be allow-listed via the comma-separated `WISP_ALLOWED_WS_ORIGINS` environment variable (rare — reverse-proxy deployments where the frontend is served from a different origin than the backend).

Rejection responses:
- Close code `1008` — Origin not allowed (or Origin header missing)
- Close code `4001` — missing or invalid token
- Close code `4000` — invalid VM name or VNC port not available

## Console UI

### Tab placement

The console is accessed via the "Console" tab in the VM overview header. It shares the center panel with the Overview tab. The VM stats bar remains visible at the bottom.

### Toolbar

A permanent bar above the console viewport (never an overlay, never hidden, never interfering with the console area). Each button shows an icon and label:

| Button | Description |
|--------|-------------|
| Ctrl+Alt+Del | Sends the Ctrl+Alt+Del key sequence to the VM |
| Paste | Pastes clipboard text into the VM |
| Screenshot | Captures a screenshot of the current console display |
| Fullscreen | Expands the console viewport only (toolbar remains visible) |
| Disconnect / Reconnect | Disconnect when connected; Reconnect when disconnected. Only one is shown at a time. |

Toolbar order: Ctrl+Alt+Del, Paste, Screenshot, (divider), Fullscreen, (divider), Disconnect or Reconnect.

### Viewport

The VNC console viewport fills the available space below the toolbar and above the VM stats bar. The noVNC client uses `scaleViewport = true` to scale the VM display to fit the viewport dimensions.

If the server closes the proxy before the VNC session is up (e.g. WebSocket code `4000` when the VM has no VNC port yet), the client does not auto-reconnect in a loop; the user can use Reconnect. Transient libvirt-not-connected failures may still retry.

## Connection Lifecycle

### Connect

When the console tab is activated for a running VM:
1. The VNC client module is loaded (dynamic ESM import of noVNC — see [noVNC.md](noVNC.md))
2. A WebSocket URL is constructed with the current auth token
3. A new `RFB` instance is created with the viewport element and WebSocket URL
4. The `shared: true` option allows multiple VNC connections to the same VM

### Auto-reconnect

When a VM transitions to the running state (detected via the VM list stream), the console automatically attempts to reconnect. This handles the case where a VM is started or rebooted while the console tab is active.

If the VNC session drops (network blip, laptop sleep, browser throttling background timers), the client retries with exponential backoff. When the tab becomes visible again or the browser fires the `online` event, the client starts a fresh connection attempt immediately instead of waiting for the next backoff interval. Restoring a page from the back-forward cache (`pageshow` with `persisted`) also triggers a fresh attempt, because WebSockets do not survive that restore.

### Disconnect

The VNC connection is cleanly disconnected when:
- The user clicks Disconnect
- The user switches to a different VM
- The user navigates away from the console tab
- The VM is stopped

### Error handling

TCP connection errors (QEMU VNC not available, VM not running) cause the WebSocket to be closed with code `1011`. The frontend displays a connection error state.

After repeated failed reconnect attempts, the UI shows a message with a Retry action instead of staying blank indefinitely.

## Backend Proxy Implementation

The backend uses Node.js built-in `net.createConnection()` to establish the TCP connection — no third-party TCP proxy library.

Server logs for the console use `scope: 'vnc-console'` and `vmName` on the child logger. Search for `get_vnc_port_failed` to see libvirt/XML failures (includes `code` such as `NO_CONNECTION`), `qemu_tcp_error` for QEMU TCP issues, and lifecycle lines `VNC opening TCP to QEMU` / `VNC TCP connected to QEMU` / `VNC WebSocket closed` to correlate a session.

The bidirectional pipe:
- WebSocket `message` event → `socket.write(data)`
- TCP `data` event → `ws.send(data)` (only if WebSocket is open, readyState === 1)
- Either side closing/erroring triggers cleanup of the other side
