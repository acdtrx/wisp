# Console

The console provides in-browser graphical access to running VMs via VNC. It uses a WebSocket proxy architecture where the browser's VNC client communicates with QEMU's VNC server through the backend.

## Architecture

```
Browser (noVNC) ──WebSocket──> Backend WS Proxy ──TCP──> QEMU VNC (127.0.0.1:port)
```

- The browser connects to `/ws/console/:name/vnc`; the upgrade request carries the `wisp_session` cookie.
- The backend connects to `127.0.0.1:<port>`. The port is not fixed: QEMU assigns it, and the backend reads it from the VM's domain XML at connection time.

## Authentication

The browser sends the same-origin `wisp_session` cookie with the WebSocket upgrade request, so consoles authenticate exactly like the REST API ([AUTH.md](AUTH.md)): the session is verified before the upgrade completes, and the answer is `401` (`AUTH_REQUIRED` / `AUTH_INVALID`, no WebSocket) when it is missing or invalid. No token travels in the URL (CODING-RULES §9). Both console routes declare the `session` access level — an `Authorization: Bearer` API token is refused with `403` `SESSION_REQUIRED`, so a leaked token can never open a shell or a VNC session. The container console (`/ws/container-console/:name`) follows the same rules.

The route also enforces a same-origin policy on the upgrade request. CORS does not apply to WebSocket, and `SameSite=Lax` still sends the cookie on an upgrade from another origin of the same site (e.g. a sibling subdomain), so without this such a page could open a WS to `/ws/console/...` and drive the VM with the user's session. In dev, only `http://localhost:5173` is allowed; in production, `Origin`'s host must equal the request `Host` header. Extra origins can be allow-listed via the comma-separated `WISP_ALLOWED_WS_ORIGINS` environment variable (rare — reverse-proxy deployments where the frontend is served from a different origin than the backend).

Rejection responses:
- HTTP `401` before the upgrade — missing or invalid session; `403` `SESSION_REQUIRED` for a bearer token
- HTTP `400` `VALIDATION_FAILED` before the upgrade — a name that breaks the [name rules](ERROR-HANDLING.md#name-validation) (and, on the container console, a PTY size out of range); the browser sees only the socket close abnormally (`1006`)
- Close code `1008` — Origin not allowed (or Origin header missing)
- Close code `4000` — VNC port not available

## Console UI

### Tab placement

The console is accessed via the "Console" tab in the VM overview header. It shares the center panel with the Overview tab.

### Toolbar

A permanent bar above the console viewport (never an overlay, never hidden, never interfering with the console area). Each button shows an icon and label:

| Button | Description |
|--------|-------------|
| Ctrl+Alt+Del | Sends the Ctrl+Alt+Del key sequence to the VM |
| Paste | Types the host clipboard text into the VM as keystrokes |
| Screenshot | Captures a screenshot of the current console display |
| Fullscreen | Expands the console viewport only (toolbar remains visible) |
| Disconnect / Reconnect | Disconnect when connected; Reconnect when disconnected. Only one is shown at a time. |

Toolbar order: Ctrl+Alt+Del, Paste, Screenshot, (divider), Fullscreen, (divider), Disconnect or Reconnect.

### Paste behavior

QEMU's built-in VNC server has no clipboard bridge to the guest OS, so the Paste button reads the browser's clipboard and types the text as VNC key events, one character at a time. This works in any guest because the guest just sees keypresses.

Limitations:
- **US keyboard layout assumed.** Uppercase letters and US-layout shifted symbols (`!@#$%^&*()_+{}|:"<>?~`) are wrapped in Shift_L. On a guest configured for a different layout, characters will come out wrong.
- **ASCII only.** Non-printable control characters are skipped, except `\n`/`\r` (sent as Enter) and `\t` (sent as Tab). Non-ASCII characters (accented letters, emoji, non-Latin scripts) are skipped.
- **Browser clipboard prompt.** Most browsers (Chrome) show a clipboard-read confirmation pill the first time the API is called. Granting persistent permission for the origin (URL bar → Site settings → Clipboard → Allow) makes subsequent pastes silent.

### Viewport

The VNC console viewport fills the available space below the toolbar. The VM display is scaled to fit the viewport.

**Console colours follow the theme** *(settled 2026-08-25)*. The terminal well is dark in **both** themes, in a shade of its own per theme. The container terminal repaints **live** on a theme flip — no reconnect, no lost scrollback. ANSI colours stay on xterm's defaults. The remote framebuffer is whatever the guest renders.

If the server closes the proxy before the VNC session is up with `4000` `vnc unavailable` (the VM has no VNC port yet — QEMU briefly reports `-1` after start/resume — or libvirt is not connected), the client treats it as transient and retries with backoff up to the attempt cap. No close code the server sends is final. An upgrade refused with a `400` (a bad name, which a URL the client builds from the VM list does not have) reaches the client as a `1006` close, like any refused upgrade, and is handled as one (Auto-reconnect, below): the session check passes, so it retries with backoff until the attempt cap, then shows the lost-connection error with Retry.

## Connection Lifecycle

### Connect

The console connects when its tab is activated for a running VM. The connection is `shared`: several VNC connections to the same VM are allowed.

### Auto-reconnect

When a VM transitions to the running state (detected via the VM list stream), the console automatically attempts to reconnect. This handles the case where a VM is started or rebooted while the console tab is active.

If the VNC session drops (network blip, laptop sleep, browser throttling background timers), the client retries with exponential backoff. Every close the client didn't make counts as a drop, however noVNC reports it, but is retried only while the VM list shows the VM running *(settled 2026-11-12)*: a VM stop closes the session too, and the reconnect on the VM's next start (above) takes over. A `1006` close is checked with one authenticated `GET /api/host` before retrying: an expired session is refused at the upgrade with HTTP `401`, which the browser only reports as `1006`, so a `401` from the probe takes the app's normal expired-session path (a redirect to `/login`) instead of spending the retry budget. When the tab becomes visible again or the browser fires the `online` event, the client starts a fresh connection attempt immediately instead of waiting for the next backoff interval. Restoring a page from the back-forward cache (`pageshow` with `persisted`) also triggers a fresh attempt, because WebSockets do not survive that restore.

**A manual Disconnect stays disconnected.** These resume triggers (visibility, `online`, bfcache restore) skip a console the user disconnected from the toolbar; it stays closed until they click Reconnect (or Retry), which clears the flag. The VM-started reconnect above is an explicit state change and still connects. The container console follows the same rules for visibility and `online`.

### Container console sessions

The container console spawns a new `/bin/sh` for every WebSocket, so its client reads the close code before deciding to reconnect *(settled 2026-10-16)*:

| Close | Meaning | Client |
|-------|---------|--------|
| `1000` `session ended` | The shell exited (`exit`, Ctrl-D, process killed) — the backend closes when exec stdout ends | **Session ended** with a Reconnect button. No new shell until the user asks for one |
| `4000` `exec failed` | The exec failed: the container is not running, or the image has no `/bin/sh` | Final error with Retry — no retry loop |
| `1006` | Abnormal close: a dropped network, the server restarting, **or** a refused upgrade. The session, the name and the PTY size are checked before the upgrade (`401`, or `400` `VALIDATION_FAILED`), so a refused upgrade never gets a close code of its own — the browser only sees `1006` | One authenticated `GET /api/host` first: a `401` takes the app's normal expired-session path (a redirect to `/login`, and the other tabs are told); otherwise retry with backoff, and once the budget is spent the lost-connection error with Retry |
| anything else (`1005` server shutdown, `1008`, `1011`) | Transient | Retry with backoff |

The retry budget (12 attempts, 1 s doubling to a 30 s cap) belongs to one connect: retries keep the count, and only a fresh connect (toolbar Reconnect/Retry, the container starting, a visibility/`online` resume) or the session's **first output frame** resets it. The socket opening is not proof — the server accepts the upgrade before it tries the exec. When the budget runs out the console shows *"Console connection was lost after several attempts"* with Retry. A session that ended or failed its exec is held closed like a manual Disconnect: the visibility/`online` resume skips it. There is no auth close code of its own: sending one would mean accepting the upgrade of an unauthenticated request just to close it.

### Disconnect

The VNC connection is cleanly disconnected when:
- The user clicks Disconnect
- The user switches to a different VM
- The user navigates away from the console tab
- The VM is stopped

### Error handling

A TCP error on the connection to QEMU's VNC port closes the WebSocket with code `1011`; a VM with no VNC port is `4000`, above. The frontend displays a connection error state.

After repeated failed reconnect attempts, the UI shows a message with a Retry action instead of staying blank indefinitely.

## Backend Proxy

The TCP leg opens only after the VNC port lookup; if the WebSocket closed during that lookup, no TCP connection to QEMU is made. Either side closing or failing closes the other.

## Timeouts

(settled 2026-11-12, CODING-RULES §6.) A console socket has no total bound — it lives as long as the user keeps it open. The client closes one still connecting after **15 s** and takes its usual retry path; the server pings every tracked socket every **30 s** and terminates one that missed the previous ping, which tears down the VNC TCP leg or the container exec session behind it. The VNC TCP connect to QEMU: **10 s**.
