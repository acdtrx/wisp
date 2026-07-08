import { RefreshCw, ServerCrash, WifiOff } from 'lucide-react';

import WispGlyph from './WispGlyph.jsx';

/**
 * Full-screen state for a boot that can't reach the backend. Without it the app
 * renders nothing, which on an iOS home-screen launch is an unrecoverable white
 * screen — there is no browser chrome to reload from.
 *
 * `kind` distinguishes the two failures that need different advice:
 *   - 'offline' — the request never reached the server (VPN down, no network).
 *   - 'server'  — the server answered, but not with a healthy response.
 */
const COPY = {
  offline: {
    Icon: WifiOff,
    title: "Can't reach Wisp",
    body: "Your device can't reach the server. If you're away from home, connect to your VPN and try again.",
  },
  server: {
    Icon: ServerCrash,
    title: "Wisp isn't responding",
    body: 'The server answered, but Wisp is not ready yet. It may be restarting or finishing an update.',
  },
};

export default function ServerUnreachable({ kind = 'offline', onRetry }) {
  const { Icon, title, body } = COPY[kind] ?? COPY.offline;

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface px-4">
      <div className="w-full max-w-sm">
        <div className="rounded-card bg-surface-card p-8 shadow-card border border-surface-border text-center">
          <WispGlyph size={32} className="mx-auto mb-4" />

          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-status-stopped-soft">
            <Icon size={22} className="text-status-stopped" />
          </div>

          <h1 className="font-display text-xl font-semibold text-text-primary">{title}</h1>
          <p className="mt-2 text-sm text-text-secondary">{body}</p>

          {/* Deliberately static. A probe against an unreachable server settles in a
              couple of milliseconds, so reflecting its in-flight state here made the
              button flash "Retrying…" on every backoff tick. The footer below already
              says retries are happening; the button only skips the wait. */}
          <button
            type="button"
            onClick={onRetry}
            className="mt-6 flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover transition-colors duration-150"
          >
            <RefreshCw size={16} />
            Retry
          </button>

          <p className="mt-3 text-xs text-text-muted">
            Retrying automatically. Wisp reconnects on its own once the server is reachable.
          </p>
        </div>
      </div>
    </div>
  );
}
