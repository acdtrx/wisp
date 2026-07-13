# Backend Routes Rules

- **Error shape:** On failure, always return `{ error: string, detail: string }`. vmManager throws `{ code, message, raw? }`; map known codes to HTTP status (404, 409, 422, 500, 503). Include `detail: err.raw || err.message` in the response.
- **SSE error payloads:** When sending an error over SSE, use the same shape: `{ error, detail }` (and optionally `code`). On the multiplexed /api/events stream the error object rides as the topic's `data`.
- **Always-on live feeds are topics on /api/events**, not new dedicated SSE endpoints (browsers cap plain-HTTP/1.1 at 6 connections per origin). Dedicated SSE endpoints are for view-scoped streams only (per-entity stats, logs, disks, usb, job progress).
- **File uploads:** Use Fastify multipart with pipeline to a write stream. Never buffer the entire file in memory.
- **CORS:** Only backend/index.js configures CORS; allow `localhost:5173` in development only. Production uses frontend proxy for /api and /ws.
